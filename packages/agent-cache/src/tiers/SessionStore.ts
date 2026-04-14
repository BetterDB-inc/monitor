import type { Valkey } from '../types';
import type { Telemetry } from '../telemetry';
import { ValkeyCommandError } from '../errors';

export interface SessionStoreConfig {
  client: Valkey;
  name: string;
  defaultTtl: number | undefined;
  tierTtl: number | undefined;
  telemetry: Telemetry;
  statsKey: string;
}

// Simple LRU tracker for active sessions (bounded to prevent memory leaks)
class SessionTracker {
  private readonly maxSize: number;
  private readonly seen: Map<string, number> = new Map();

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  add(threadId: string): boolean {
    if (this.seen.has(threadId)) {
      // Update access time for LRU
      this.seen.set(threadId, Date.now());
      return false; // Already tracked
    }

    // Evict oldest if at capacity
    if (this.seen.size >= this.maxSize) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [key, time] of this.seen) {
        if (time < oldestTime) {
          oldestTime = time;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.seen.delete(oldestKey);
      }
    }

    this.seen.set(threadId, Date.now());
    return true; // Newly tracked
  }

  remove(threadId: string): boolean {
    return this.seen.delete(threadId);
  }
}

export class SessionStore {
  private readonly client: Valkey;
  private readonly name: string;
  private readonly defaultTtl: number | undefined;
  private readonly tierTtl: number | undefined;
  private readonly telemetry: Telemetry;
  private readonly statsKey: string;
  private readonly sessionTracker: SessionTracker;

  constructor(config: SessionStoreConfig) {
    this.client = config.client;
    this.name = config.name;
    this.defaultTtl = config.defaultTtl;
    this.tierTtl = config.tierTtl;
    this.telemetry = config.telemetry;
    this.statsKey = config.statsKey;
    this.sessionTracker = new SessionTracker();
  }

  private buildKey(threadId: string, field: string): string {
    return `${this.name}:session:${threadId}:${field}`;
  }

  async get(threadId: string, field: string): Promise<string | null> {
    const startTime = Date.now();

    return this.telemetry.tracer.startActiveSpan('agent_cache.session.get', async (span) => {
      try {
        const key = this.buildKey(threadId, field);

        span.setAttribute('cache.key', key);
        span.setAttribute('cache.thread_id', threadId);
        span.setAttribute('cache.field', field);

        let value: string | null;
        try {
          value = await this.client.get(key);
        } catch (err) {
          throw new ValkeyCommandError('GET', err);
        }

        const duration = (Date.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels(this.name, 'session', 'get')
          .observe(duration);

        // Record read for all operations (hits and misses)
        try {
          await this.client.hincrby(this.statsKey, 'session:reads', 1);
        } catch {
          // Stats update failure should not break the cache
        }

        if (value !== null) {
          // Refresh TTL (sliding window)
          const ttl = this.tierTtl ?? this.defaultTtl;
          if (ttl !== undefined) {
            try {
              await this.client.expire(key, ttl);
            } catch {
              // TTL refresh failure should not break the read
            }
          }
        }

        span.setAttribute('cache.hit', value !== null);
        span.end();

        return value;
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async set(threadId: string, field: string, value: string, ttl?: number): Promise<void> {
    const startTime = Date.now();

    return this.telemetry.tracer.startActiveSpan('agent_cache.session.set', async (span) => {
      try {
        const key = this.buildKey(threadId, field);

        span.setAttribute('cache.key', key);
        span.setAttribute('cache.thread_id', threadId);
        span.setAttribute('cache.field', field);

        // Use SET with EX option for atomic set+expire to prevent orphaned keys
        const effectiveTtl = ttl ?? this.tierTtl ?? this.defaultTtl;
        try {
          if (effectiveTtl !== undefined) {
            await this.client.set(key, value, 'EX', effectiveTtl);
          } else {
            await this.client.set(key, value);
          }
        } catch (err) {
          throw new ValkeyCommandError('SET', err);
        }

        // Record write
        try {
          await this.client.hincrby(this.statsKey, 'session:writes', 1);
        } catch {
          // Stats update failure should not break the cache
        }

        // Track active session (increment gauge on first write per thread)
        const isNew = this.sessionTracker.add(threadId);
        if (isNew) {
          this.telemetry.metrics.activeSessions
            .labels(this.name)
            .inc();
        }

        // Track stored bytes
        const byteLength = Buffer.byteLength(value, 'utf8');
        this.telemetry.metrics.storedBytes
          .labels(this.name, 'session')
          .inc(byteLength);

        const duration = (Date.now() - startTime) / 1000;
        this.telemetry.metrics.operationDuration
          .labels(this.name, 'session', 'set')
          .observe(duration);

        span.setAttribute('cache.ttl', effectiveTtl ?? -1);
        span.setAttribute('cache.bytes', byteLength);
        span.end();
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async getAll(threadId: string): Promise<Record<string, string>> {
    return this.telemetry.tracer.startActiveSpan('agent_cache.session.getAll', async (span) => {
      try {
        span.setAttribute('cache.thread_id', threadId);

        const pattern = `${this.name}:session:${threadId}:*`;
        const result: Record<string, string> = {};
        const keysToRefresh: string[] = [];
        let cursor = '0';

        do {
          let scanResult: [string, string[]];
          try {
            scanResult = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          } catch (err) {
            throw new ValkeyCommandError('SCAN', err);
          }

          cursor = scanResult[0];
          const keys = scanResult[1];

          if (keys.length > 0) {
            try {
              const values = await this.client.mget(...keys);
              for (let i = 0; i < keys.length; i++) {
                const value = values[i];
                if (value !== null) {
                  // Extract field name from key (strip prefix)
                  const prefix = `${this.name}:session:${threadId}:`;
                  const field = keys[i].slice(prefix.length);
                  result[field] = value;
                  keysToRefresh.push(keys[i]);
                }
              }
            } catch (err) {
              throw new ValkeyCommandError('MGET', err);
            }
          }
        } while (cursor !== '0');

        // Refresh TTL on all found keys (sliding window)
        const ttl = this.tierTtl ?? this.defaultTtl;
        if (ttl !== undefined && keysToRefresh.length > 0) {
          const pipeline = this.client.pipeline();
          for (const key of keysToRefresh) {
            pipeline.expire(key, ttl);
          }
          try {
            await pipeline.exec();
          } catch {
            // TTL refresh failure should not break the read
          }
        }

        span.setAttribute('cache.field_count', Object.keys(result).length);
        span.end();

        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async delete(threadId: string, field: string): Promise<boolean> {
    const key = this.buildKey(threadId, field);

    try {
      const deleted = await this.client.del(key);
      return deleted > 0;
    } catch (err) {
      throw new ValkeyCommandError('DEL', err);
    }
  }

  async destroyThread(threadId: string): Promise<number> {
    return this.telemetry.tracer.startActiveSpan('agent_cache.session.destroyThread', async (span) => {
      try {
        span.setAttribute('cache.thread_id', threadId);

        const pattern = `${this.name}:session:${threadId}:*`;
        let cursor = '0';
        let deletedCount = 0;

        do {
          let scanResult: [string, string[]];
          try {
            scanResult = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          } catch (err) {
            throw new ValkeyCommandError('SCAN', err);
          }

          cursor = scanResult[0];
          const keys = scanResult[1];

          if (keys.length > 0) {
            try {
              const deleted = await this.client.del(...keys);
              deletedCount += deleted;
            } catch (err) {
              throw new ValkeyCommandError('DEL', err);
            }
          }
        } while (cursor !== '0');

        // Decrement active sessions gauge
        if (this.sessionTracker.remove(threadId)) {
          this.telemetry.metrics.activeSessions
            .labels(this.name)
            .dec();
        }

        span.setAttribute('cache.deleted_count', deletedCount);
        span.end();

        return deletedCount;
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }

  async touch(threadId: string): Promise<void> {
    return this.telemetry.tracer.startActiveSpan('agent_cache.session.touch', async (span) => {
      try {
        span.setAttribute('cache.thread_id', threadId);

        const pattern = `${this.name}:session:${threadId}:*`;
        const ttl = this.tierTtl ?? this.defaultTtl;

        if (ttl === undefined) {
          span.end();
          return;
        }

        let cursor = '0';
        let touchedCount = 0;

        do {
          let scanResult: [string, string[]];
          try {
            scanResult = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
          } catch (err) {
            throw new ValkeyCommandError('SCAN', err);
          }

          cursor = scanResult[0];
          const keys = scanResult[1];

          if (keys.length > 0) {
            const pipeline = this.client.pipeline();
            for (const key of keys) {
              pipeline.expire(key, ttl);
            }
            try {
              await pipeline.exec();
              touchedCount += keys.length;
            } catch (err) {
              throw new ValkeyCommandError('EXPIRE', err);
            }
          }
        } while (cursor !== '0');

        span.setAttribute('cache.touched_count', touchedCount);
        span.end();
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }
}
