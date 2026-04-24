import { describe, it, expect, vi } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

function makeMockClient(mockSearchResult?: { key: string; fields: Record<string, string> }) {
  const hashStore = new Map<string, Record<string, string>>();
  const kvStore = new Map<string, Buffer | null>();

  return {
    hashStore,
    kvStore,
    call: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']]],
        ];
      }
      if (cmd === 'FT.CREATE') return 'OK';
      if (cmd === 'FT.DROPINDEX') return 'OK';
      if (cmd === 'FT.SEARCH') {
        if (!mockSearchResult) return ['0'];
        const { key, fields } = mockSearchResult;
        return [
          '1',
          key,
          Object.entries(fields).flatMap(([k, v]) => [k, v]).concat(['__score', '0.01']),
        ];
      }
      return null;
    }),
    hset: vi.fn(async () => 1),
    hgetall: vi.fn(async (key: string) => hashStore.get(key) ?? {}),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async (key: string) => kvStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: Buffer) => {
      kvStore.set(key, value);
      return 'OK';
    }),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => []),
      zadd: vi.fn().mockReturnThis(),
      zremrangebyscore: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
    })),
    zrange: vi.fn(async () => []),
    nodes: vi.fn(() => null),
  };
}

describe('embedding cache', () => {
  it('first call invokes embedFn', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_emb',
      embeddingCache: { enabled: true, ttl: 3600 },
    });
    await cache.initialize();

    await cache.store('Hello world', 'Hi');
    // FT.INFO returns dim 2, no probe needed during init
    // store() calls embed once
    expect(embedFn).toHaveBeenCalledTimes(1);
  });

  it('second call on same text does not invoke embedFn', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_emb2',
      embeddingCache: { enabled: true, ttl: 3600 },
    });
    await cache.initialize();

    // First store - calls embedFn
    await cache.store('Hello', 'Hi');
    const firstCount = embedFn.mock.calls.length;

    // Second store of same text - should use cached embedding (kvStore has the buffer)
    await cache.store('Hello', 'Hi again');
    // embedFn should NOT be called again if embedding cache hit
    // But since we're mocking getBuffer to return from kvStore, and set is called by first store,
    // the second call should use the cached value
    expect(embedFn.mock.calls.length).toBe(firstCount);
  });

  it('different text calls embedFn again', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_emb3',
      embeddingCache: { enabled: true },
    });
    await cache.initialize();

    await cache.store('Hello', 'Hi');
    const countAfterFirst = embedFn.mock.calls.length;

    await cache.store('World', 'Earth');
    expect(embedFn.mock.calls.length).toBeGreaterThan(countAfterFirst);
  });

  it('disabled embedding cache always calls embedFn', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_emb_off',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    await cache.store('Hello', 'Hi');
    await cache.store('Hello', 'Hi again');
    // Both calls should invoke embedFn since cache is disabled
    expect(embedFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Verify kvStore was NOT written to (no set calls for embed keys)
    const embedKeys = [...client.kvStore.keys()].filter((k) => k.includes(':embed:'));
    expect(embedKeys.length).toBe(0);
  });
});
