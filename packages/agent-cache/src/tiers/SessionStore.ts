import type { Valkey } from '../types';
import type { Telemetry } from '../telemetry';
import { ValkeyCommandError } from '../errors';
import { escapeGlobPattern } from '../utils';
import { clusterScan } from '../cluster';

export interface SessionStoreConfig {
  client: Valkey;
  name: string;
  defaultTtl: number | undefined;
  tierTtl: number | undefined;
  telemetry: Telemetry;
  statsKey: string;
}

// Simple LRU tracker for active sessions (bounded to prevent memory leaks).
// Note: Eviction is O(n) but n is bounded at maxSize (default 10k entries).
// For typical agent workloads this is acceptable (~1-2ms worst case).
// A proper LRU with doubly-linked list would add complexity without meaningful benefit.
export class SessionTracker {
  private readonly maxSize: number;
  private readonly seen: Map<string, number> = new Map();

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  /**
   * Track a thread. Returns { isNew: true, evicted: string } if newly tracked
   * (and optionally which thread was evicted to make room).
   * Returns { isNew: false } if already tracked.
   */
  add(threadId: string): { isNew: boolean; evicted?: string } {
    if (this.seen.has(threadId)) {
      // Update access time for LRU
      this.seen.set(threadId, Date.now());
      return { isNew: false };
    }

    let evicted: string | undefined;

    // Evict oldest if at capacity (O(n) scan, bounded at maxSize)
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
        evicted = oldestKey;
      }
    }

    this.seen.set(threadId, Date.now());
    return { isNew: true, evicted };
  }

  remove(threadId: string): boolean {
    return this.seen.delete(threadId);
  }

  /**
   * Reset the tracker, clearing all tracked sessions.
   * Returns the number of sessions that were being tracked.
   */
  reset(): number {
    const count = this.seen.size;
    this.seen.clear();
    return count;
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
        const { isNew, evicted } = this.sessionTracker.add(threadId);
        if (isNew) {
          this.telemetry.metrics.activeSessions
            .labels(this.name)
            .inc();
        }
        // Decrement gauge if a session was evicted to make room
        if (evicted) {
          this.telemetry.metrics.activeSessions
            .labels(this.name)
            .dec();
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

        // Escape glob chars to prevent threadId or cache name from matching unintended keys
        const pattern = `${escapeGlobPattern(this.name)}:session:${escapeGlobPattern(threadId)}:*`;
        const result: Record<string, string> = {};
        const ttl = this.tierTtl ?? this.defaultTtl;
        const prefix = `${this.name}:session:${threadId}:`;

        await clusterScan(this.client, pattern, async (keys, nodeClient) => {
          // Pipeline GET — individual commands avoid CROSSSLOT in cluster mode
          const getPipeline = nodeClient.pipeline();
          for (const key of keys) getPipeline.get(key);

          let getResults: Array<[Error | null, string | null]>;
          try {
            getResults = await getPipeline.exec() as Array<[Error | null, string | null]>;
          } catch (err) {
            throw new ValkeyCommandError('GET', err);
          }

          const keysToRefresh: string[] = [];
          for (let i = 0; i < keys.length; i++) {
            const [err, value] = getResults[i];
            if (err || value === null) continue;
            result[keys[i].slice(prefix.length)] = value;
            keysToRefresh.push(keys[i]);
          }

          // Refresh TTL per batch on this node (sliding window)
          if (ttl !== undefined && keysToRefresh.length > 0) {
            const expPipeline = nodeClient.pipeline();
            for (const key of keysToRefresh) expPipeline.expire(key, ttl);
            try {
              await expPipeline.exec();
            } catch {
              // TTL refresh failure should not break the read
            }
          }
        });

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

  /**
   * Scan for session fields matching a prefix within a thread.
   * Unlike getAll(), this does NOT refresh TTL on matched keys (no sliding window side effect).
   * Useful when callers only need a subset of fields and don't want to extend TTL on unrelated data.
   */
  async scanFieldsByPrefix(threadId: string, fieldPrefix: string): Promise<Record<string, string>> {
    const pattern = `${escapeGlobPattern(this.name)}:session:${escapeGlobPattern(threadId)}:${escapeGlobPattern(fieldPrefix)}*`;
    const result: Record<string, string> = {};
    const keyPrefix = `${this.name}:session:${threadId}:`;

    await clusterScan(this.client, pattern, async (keys, nodeClient) => {
      // Pipeline GET — individual commands avoid CROSSSLOT in cluster mode
      const pipeline = nodeClient.pipeline();
      for (const key of keys) pipeline.get(key);

      let getResults: Array<[Error | null, string | null]>;
      try {
        getResults = await pipeline.exec() as Array<[Error | null, string | null]>;
      } catch (err) {
        throw new ValkeyCommandError('GET', err);
      }

      for (let i = 0; i < keys.length; i++) {
        const [err, value] = getResults[i];
        if (err || value === null) continue;
        result[keys[i].slice(keyPrefix.length)] = value;
      }
    });

    return result;
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

        // Escape glob chars to match only this thread's keys during SCAN.
        const pattern = `${escapeGlobPattern(this.name)}:session:${escapeGlobPattern(threadId)}:*`;
        let deletedCount = 0;

        await clusterScan(this.client, pattern, async (keys, nodeClient) => {
          // Pipeline DEL — individual commands avoid CROSSSLOT in cluster mode
          const pipeline = nodeClient.pipeline();
          for (const key of keys) pipeline.del(key);
          let delResults: Array<[Error | null, number]>;
          try {
            delResults = await pipeline.exec() as Array<[Error | null, number]>;
          } catch (err) {
            throw new ValkeyCommandError('DEL', err);
          }
          for (const [err, count] of delResults) {
            if (err) throw new ValkeyCommandError('DEL', err);
            deletedCount += count ?? 0;
          }
        });

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

  /**
   * Reset the in-memory session tracker and decrement the gauge.
   * Called by AgentCache.flush() to synchronize in-memory state with Valkey.
   */
  resetTracker(): void {
    this.sessionTracker.reset();
    // Use set(0) rather than dec(count) — the gauge may have drifted from
    // evictions or process restarts, and dec() doesn't clamp at zero.
    this.telemetry.metrics.activeSessions
      .labels(this.name)
      .set(0);
  }

  async touch(threadId: string): Promise<void> {
    return this.telemetry.tracer.startActiveSpan('agent_cache.session.touch', async (span) => {
      try {
        span.setAttribute('cache.thread_id', threadId);

        // Escape glob chars to prevent threadId or cache name from matching unintended keys
        const pattern = `${escapeGlobPattern(this.name)}:session:${escapeGlobPattern(threadId)}:*`;
        const ttl = this.tierTtl ?? this.defaultTtl;

        if (ttl === undefined) {
          span.end();
          return;
        }

        let touchedCount = 0;

        await clusterScan(this.client, pattern, async (keys, nodeClient) => {
          const pipeline = nodeClient.pipeline();
          for (const key of keys) pipeline.expire(key, ttl);
          try {
            await pipeline.exec();
            // Per-command EXPIRE results are intentionally not inspected here —
            // unlike DEL, a key disappearing between SCAN and EXPIRE is harmless
            // (it was already gone). DEL pipelines must inspect results because a
            // failed delete would silently leave a key behind. The _approx suffix
            // on the span attribute documents this over-counting trade-off.
            touchedCount += keys.length;
          } catch (err) {
            throw new ValkeyCommandError('EXPIRE', err);
          }
        });

        span.setAttribute('cache.touched_count_approx', touchedCount);
        span.end();
      } catch (err) {
        span.recordException(err as Error);
        span.end();
        throw err;
      }
    });
  }
}
