import { describe, it, expect } from 'vitest';
import { SemanticCache } from '../SemanticCache';

class StubValkey {
  zsets = new Map<string, Array<{ score: number; member: string }>>();

  async zadd(key: string, score: number, member: string): Promise<number> {
    const list = this.zsets.get(key) ?? [];
    list.push({ score, member });
    this.zsets.set(key, list);
    return 1;
  }

  async zrange(
    key: string,
    _start: string | number,
    _stop: string | number,
    mode?: string,
  ): Promise<string[]> {
    const list = (this.zsets.get(key) ?? []).slice().sort((a, b) => a.score - b.score);
    if (mode === 'WITHSCORES') {
      const out: string[] = [];
      for (const e of list) {
        out.push(e.member, String(e.score));
      }
      return out;
    }
    return list.map((e) => e.member);
  }

  async zrem(key: string, member: string): Promise<number> {
    const list = this.zsets.get(key) ?? [];
    const next = list.filter((e) => e.member !== member);
    this.zsets.set(key, next);
    return list.length - next.length;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    const entry = (this.zsets.get(key) ?? []).find((e) => e.member === member);
    return entry ? String(entry.score) : null;
  }

  async zremrangebyscore(key: string, _min: string, maxRaw: string | number): Promise<number> {
    const maxStr = typeof maxRaw === 'string' ? maxRaw : String(maxRaw);
    const max = maxStr.startsWith('(') ? Number(maxStr.slice(1)) : Number(maxStr);
    const list = this.zsets.get(key) ?? [];
    const next = list.filter((e) => e.score > max);
    this.zsets.set(key, next);
    return list.length - next.length;
  }

  pipeline() {
    const ops: Array<[string, unknown[]]> = [];
    const p = {
      zadd: (key: string, score: number, member: string) => {
        ops.push(['zadd', [key, score, member]]);
        return p;
      },
      zrem: (key: string, member: string) => {
        ops.push(['zrem', [key, member]]);
        return p;
      },
      zremrangebyscore: () => p,
      zremrangebyrank: () => p,
    } as Record<string, unknown>;
    p['exec'] = async () => {
      for (const [op, args] of ops) {
        if (op === 'zadd') {
          const [key, score, member] = args as [string, number, string];
          const list = this.zsets.get(key) ?? [];
          list.push({ score, member });
          this.zsets.set(key, list);
        }
        if (op === 'zrem') {
          const [key, member] = args as [string, string];
          const list = this.zsets.get(key) ?? [];
          this.zsets.set(key, list.filter((e) => e.member !== member));
        }
      }
      return [];
    };
    return p as {
      zadd: (k: string, s: number, m: string) => unknown;
      zrem: (k: string, m: string) => unknown;
      zremrangebyscore: (k: string, a: string, b: string | number) => unknown;
      zremrangebyrank: (k: string, a: number, b: number) => unknown;
      exec: () => Promise<unknown[]>;
    };
  }
}

describe('cost instrumentation on similarity-window writes', () => {
  it('records cost_saved_micros on hit', async () => {
    const client = new StubValkey();
    const cache = Object.create(SemanticCache.prototype) as {
      similarityWindowKey: string;
      client: StubValkey;
      recordSimilarityWindow: (
        score: number,
        result: 'hit' | 'miss',
        category: string,
        costSavedMicros: number | null,
      ) => Promise<string>;
    };
    cache.similarityWindowKey = 'test:__similarity_window';
    cache.client = client;
    await cache.recordSimilarityWindow(0.08, 'hit', 'all', 1500);

    const entries = client.zsets.get('test:__similarity_window') ?? [];
    expect(entries).toHaveLength(1);
    const parsed = JSON.parse(entries[0].member);
    expect(parsed.cost_saved_micros).toBe(1500);
    expect(parsed.result).toBe('hit');
  });

  it('records cost_saved_micros: null on miss', async () => {
    const client = new StubValkey();
    const cache = Object.create(SemanticCache.prototype) as {
      similarityWindowKey: string;
      client: StubValkey;
      recordSimilarityWindow: (
        score: number,
        result: 'hit' | 'miss',
        category: string,
        costSavedMicros: number | null,
      ) => Promise<string>;
    };
    cache.similarityWindowKey = 'test:__similarity_window';
    cache.client = client;
    await cache.recordSimilarityWindow(0.15, 'miss', 'all', null);

    const entries = client.zsets.get('test:__similarity_window') ?? [];
    expect(entries).toHaveLength(1);
    const parsed = JSON.parse(entries[0].member);
    expect(parsed.cost_saved_micros).toBeNull();
    expect(parsed.result).toBe('miss');
  });

  it('writes a __miss_pending entry on miss and applies cost on subsequent store', async () => {
    const client = new StubValkey();
    type CachePrivates = {
      similarityWindowKey: string;
      missPendingKey: string;
      client: StubValkey;
      recordSimilarityWindow: (
        score: number,
        result: 'hit' | 'miss',
        category: string,
        cost: number | null,
      ) => Promise<string>;
      recordMissPending: (prompt: string, member: string) => Promise<void>;
      applyCostToPendingMiss: (prompt: string, costMicros: number) => Promise<void>;
    };
    const cache = Object.create(SemanticCache.prototype) as CachePrivates;
    cache.similarityWindowKey = 'test:__similarity_window';
    cache.missPendingKey = 'test:__miss_pending';
    cache.client = client;

    const member = await cache.recordSimilarityWindow(0.18, 'miss', 'all', null);
    await cache.recordMissPending('what is the capital of France', member);
    await cache.applyCostToPendingMiss('what is the capital of France', 2500);

    const entries = client.zsets.get('test:__similarity_window') ?? [];
    expect(entries).toHaveLength(1);
    const parsed = JSON.parse(entries[0].member);
    expect(parsed.cost_saved_micros).toBe(2500);
    expect(parsed.result).toBe('miss');
  });

  it('recordMissPending prunes entries older than the 5-minute bound', async () => {
    const client = new StubValkey();
    type CachePrivates = {
      missPendingKey: string;
      client: StubValkey;
      recordMissPending: (prompt: string, member: string) => Promise<void>;
    };
    const cache = Object.create(SemanticCache.prototype) as CachePrivates;
    cache.missPendingKey = 'test:__miss_pending';
    cache.client = client;

    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    await client.zadd('test:__miss_pending', tenMinutesAgo, '{"stale":true}');

    await cache.recordMissPending('fresh query', 'member-1');

    const entries = client.zsets.get('test:__miss_pending') ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0].member).not.toContain('stale');
  });

  it('applyCostToPendingMiss is a no-op when no pending miss exists', async () => {
    const client = new StubValkey();
    type CachePrivates = {
      similarityWindowKey: string;
      missPendingKey: string;
      client: StubValkey;
      applyCostToPendingMiss: (prompt: string, costMicros: number) => Promise<void>;
    };
    const cache = Object.create(SemanticCache.prototype) as CachePrivates;
    cache.similarityWindowKey = 'test:__similarity_window';
    cache.missPendingKey = 'test:__miss_pending';
    cache.client = client;

    await expect(
      cache.applyCostToPendingMiss('never-seen-before query', 500),
    ).resolves.toBeUndefined();
  });
});
