import { describe, it, expect, vi } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import { describeEmbedder, getEmbedderDescriptor } from '../embedder-identity';
import { createGoogleEmbed, type GoogleEmbedOptions } from '../embed/google';
import type { EmbedFn, EmbedderDescriptor, Valkey } from '../types';

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
          Object.entries(fields)
            .flatMap(([k, v]) => [k, v])
            .concat(['__score', '0.01']),
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

describe('embedding cache namespacing', () => {
  type MockClient = ReturnType<typeof makeMockClient>;

  function googleDescriptor(opts: GoogleEmbedOptions): EmbedderDescriptor {
    return getEmbedderDescriptor(createGoogleEmbed(opts)) as EmbedderDescriptor;
  }

  async function warmThenProbe(
    client: MockClient,
    first: EmbedderDescriptor | undefined,
    second: EmbedderDescriptor | undefined,
  ): Promise<number> {
    const embed: EmbedFn = async () => {
      return [0.5, 0.5];
    };
    const warming = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: first === undefined ? embed : describeEmbedder(embed, first),
      name: 'test_ns',
      embeddingCache: { enabled: true, ttl: 3600 },
    });
    await warming.initialize();
    await warming.store('Hello world', 'Hi');

    const probe = vi.fn(async () => {
      return [0.5, 0.5];
    });
    const reading = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: second === undefined ? probe : describeEmbedder(probe, second),
      name: 'test_ns',
      embeddingCache: { enabled: true, ttl: 3600 },
    });
    await reading.initialize();
    await reading.store('Hello world', 'Hi');
    return probe.mock.calls.length;
  }

  it('re-embeds when the descriptor differs', async () => {
    const calls = await warmThenProbe(
      makeMockClient(),
      { provider: 'openai', model: 'text-embedding-3-small' },
      { provider: 'openai', model: 'text-embedding-3-large' },
    );

    expect(calls).toBe(1);
  });

  it('shares cached vectors when the descriptor matches', async () => {
    const calls = await warmThenProbe(
      makeMockClient(),
      { provider: 'openai', model: 'text-embedding-3-small' },
      { provider: 'openai', model: 'text-embedding-3-small' },
    );

    expect(calls).toBe(0);
  });

  it('keeps an undescribed embedder sharing its own namespace across instances', async () => {
    const calls = await warmThenProbe(makeMockClient(), undefined, undefined);

    expect(calls).toBe(0);
  });

  it('re-embeds when a google document title changes the text behind the same key', async () => {
    const calls = await warmThenProbe(
      makeMockClient(),
      googleDescriptor({ taskType: 'RETRIEVAL_DOCUMENT', title: 'Release notes' }),
      googleDescriptor({ taskType: 'RETRIEVAL_DOCUMENT', title: 'Runbook' }),
    );

    expect(calls).toBe(1);
  });

  it('shares vectors across a title the request never carries', async () => {
    const calls = await warmThenProbe(
      makeMockClient(),
      googleDescriptor({ taskType: 'RETRIEVAL_QUERY', title: 'Release notes' }),
      googleDescriptor({ taskType: 'RETRIEVAL_QUERY', title: 'Runbook' }),
    );

    expect(calls).toBe(0);
  });

  it("does not let an undescribed embedder read a described one's vectors", async () => {
    const calls = await warmThenProbe(
      makeMockClient(),
      { provider: 'openai', model: 'small' },
      undefined,
    );

    expect(calls).toBe(1);
  });
});
