import { describe, it, expect } from 'vitest';
import { SemanticCache } from '../SemanticCache';

class StubValkey {
  zsets = new Map<string, Array<{ score: number; member: string }>>();

  pipeline() {
    const ops: Array<[string, unknown[]]> = [];
    const p = {
      zadd: (key: string, score: number, member: string) => {
        ops.push(['zadd', [key, score, member]]);
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
      }
      return [];
    };
    return p as {
      zadd: (k: string, s: number, m: string) => unknown;
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
});
