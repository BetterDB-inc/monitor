import { describe, expect, it, vi } from 'vitest';

import { SemanticCache } from '../SemanticCache';
import { REGISTRY_KEY } from '../discovery';
import { describeEmbedder } from '../embedder-identity';
import { EmbeddingModelChangedError } from '../errors';
import type { EmbedFn, EmbedderDescriptor, SemanticCacheOptions, Valkey } from '../types';

const OPENAI_SMALL: EmbedderDescriptor = {
  provider: 'openai',
  model: 'text-embedding-3-small',
};
const OPENAI_LARGE: EmbedderDescriptor = {
  provider: 'openai',
  model: 'text-embedding-3-large',
};

function makeMockClient() {
  const hashes = new Map<string, Map<string, string>>();
  const client = {
    hashes,
    droppedIndexes: [] as string[],
    freezeRegistry: false,
    call: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']]],
        ];
      }
      if (cmd === 'FT.DROPINDEX') {
        client.droppedIndexes.push(args[1] as string);
        return 'OK';
      }
      if (cmd === 'FT.CREATE') {
        return 'OK';
      }
      if (cmd === 'FT.SEARCH') {
        return ['0'];
      }
      return null;
    }),
    hget: vi.fn(async (key: string, field: string) => {
      return hashes.get(key)?.get(field) ?? null;
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      if (client.freezeRegistry && key === REGISTRY_KEY) {
        return 0;
      }
      let hash = hashes.get(key);
      if (hash === undefined) {
        hash = new Map<string, string>();
        hashes.set(key, hash);
      }
      hash.set(field, value);
      return 1;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      if (client.freezeRegistry && key === REGISTRY_KEY) {
        return 0;
      }
      return hashes.get(key)?.delete(field) === true ? 1 : 0;
    }),
    hgetall: vi.fn(async () => {
      return {};
    }),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    pipeline: vi.fn(() => {
      return {
        hincrby: vi.fn().mockReturnThis(),
        zadd: vi.fn().mockReturnThis(),
        zremrangebyscore: vi.fn().mockReturnThis(),
        zremrangebyrank: vi.fn().mockReturnThis(),
        exec: vi.fn(async () => []),
      };
    }),
    zrange: vi.fn(async () => []),
    nodes: vi.fn(() => null),
  };
  return client;
}

type MockClient = ReturnType<typeof makeMockClient>;

function embedWith(descriptor: EmbedderDescriptor | undefined): EmbedFn {
  const fn: EmbedFn = async () => {
    return [0.1, 0.2];
  };
  if (descriptor === undefined) {
    return fn;
  }
  return describeEmbedder(fn, descriptor);
}

function makeCache(
  client: MockClient,
  descriptor: EmbedderDescriptor | undefined,
  overrides: Partial<SemanticCacheOptions> = {},
): { cache: SemanticCache; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const cache = new SemanticCache({
    client: client as unknown as Valkey,
    embedFn: embedWith(descriptor),
    name: 'model_change',
    embeddingCache: { enabled: false },
    configRefresh: { enabled: false },
    logger: { warn },
    ...overrides,
  });
  return { cache, warn };
}

function markerModel(client: MockClient): unknown {
  const raw = client.hashes.get(REGISTRY_KEY)?.get('model_change');
  return raw === undefined ? undefined : JSON.parse(raw).embedding_model;
}

async function seed(
  client: MockClient,
  descriptor: EmbedderDescriptor | undefined,
): Promise<SemanticCache> {
  const { cache } = makeCache(client, descriptor);
  await cache.initialize();
  await cache.dispose();
  return cache;
}

describe('embedding model change detection', () => {
  it('proceeds silently on the very first run', async () => {
    const client = makeMockClient();
    const { cache, warn } = makeCache(client, OPENAI_SMALL);

    await expect(cache.initialize()).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
    expect(markerModel(client)).toBe('openai:text-embedding-3-small');
    await cache.dispose();
  });

  it('proceeds silently when the recorded model matches', async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache, warn } = makeCache(client, OPENAI_SMALL);
    await cache.initialize();

    expect(warn).not.toHaveBeenCalled();
    await cache.dispose();
  });

  it('throws by default when the model changed', async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache } = makeCache(client, OPENAI_LARGE);

    await expect(cache.initialize()).rejects.toBeInstanceOf(EmbeddingModelChangedError);
  });

  it('names both models and the remedy in the error', async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache } = makeCache(client, OPENAI_LARGE);
    const error = await cache.initialize().catch((err: unknown) => {
      return err as EmbeddingModelChangedError;
    });

    expect(error.expected).toBe('openai:text-embedding-3-small');
    expect(error.actual).toBe('openai:text-embedding-3-large');
    expect(error.message).toContain('openai:text-embedding-3-small');
    expect(error.message).toContain('openai:text-embedding-3-large');
    expect(error.message).toContain('flush()');
  });

  it('leaves the cache uninitialized after throwing', async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache } = makeCache(client, OPENAI_LARGE);
    await cache.initialize().catch(() => {});

    await expect(cache.check('hello')).rejects.toThrow(/initialize/i);
  });

  it("warns and carries on under 'warn'", async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache, warn } = makeCache(client, OPENAI_LARGE, {
      onEmbeddingModelChange: 'warn',
    });
    await cache.initialize();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('embedding model changed');
    expect(client.droppedIndexes).toEqual([]);
    expect(markerModel(client)).toBe('openai:text-embedding-3-large');
    await cache.dispose();
  });

  it("drops the index and adopts the new model under 'flush'", async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache, warn } = makeCache(client, OPENAI_LARGE, {
      onEmbeddingModelChange: 'flush',
    });
    await cache.initialize();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(client.droppedIndexes).toEqual(['model_change:idx']);
    expect(markerModel(client)).toBe('openai:text-embedding-3-large');
    await cache.dispose();
  });

  it("is initialized and usable after a 'flush' outcome", async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache } = makeCache(client, OPENAI_LARGE, { onEmbeddingModelChange: 'flush' });
    await cache.initialize();

    await expect(cache.check('hello')).resolves.toBeDefined();
    await cache.dispose();
  });

  it("is silent on the next start after a 'flush' outcome", async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const flushing = makeCache(client, OPENAI_LARGE, { onEmbeddingModelChange: 'flush' });
    await flushing.cache.initialize();
    await flushing.cache.dispose();

    const { cache, warn } = makeCache(client, OPENAI_LARGE);
    await cache.initialize();

    expect(warn).not.toHaveBeenCalled();
    await cache.dispose();
  });

  it('adopts a pre-upgrade marker that records no model', async () => {
    const client = makeMockClient();
    await seed(client, undefined);

    const { cache, warn } = makeCache(client, OPENAI_SMALL);
    await cache.initialize();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('predates');
    expect(markerModel(client)).toBe('openai:text-embedding-3-small');
    await cache.dispose();
  });

  it('warns that detection is inactive when this embedder is undescribed', async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache, warn } = makeCache(client, undefined);
    await cache.initialize();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('cannot be verified');
    await cache.dispose();
  });

  it('warns that detection is inactive when neither side records a model', async () => {
    const client = makeMockClient();
    await seed(client, undefined);

    const { cache, warn } = makeCache(client, undefined);
    await cache.initialize();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('detection is inactive');
    await cache.dispose();
  });

  it('warns at most once per instance even while the mismatch persists', async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);
    // Freeze the registry so the marker keeps reporting the old model and the
    // second initialize() sees the very same mismatch as the first.
    client.freezeRegistry = true;

    const { cache, warn } = makeCache(client, OPENAI_LARGE, {
      onEmbeddingModelChange: 'warn',
    });
    await cache.initialize();
    await cache.flush();
    await cache.initialize();

    expect(markerModel(client)).toBe('openai:text-embedding-3-small');
    expect(warn).toHaveBeenCalledTimes(1);
    await cache.dispose();
  });

  it('warns rather than starting silently on a marker it cannot parse', async () => {
    const client = makeMockClient();
    client.hashes.set(REGISTRY_KEY, new Map([['model_change', 'not json']]));

    const { cache, warn } = makeCache(client, OPENAI_SMALL);
    await cache.initialize();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not valid JSON');
    await cache.dispose();
  });

  it('leaves no stale marker behind for the next start to trip over', async () => {
    const client = makeMockClient();
    await seed(client, OPENAI_SMALL);

    const { cache } = makeCache(client, OPENAI_LARGE, { onEmbeddingModelChange: 'flush' });
    await cache.initialize();
    await cache.dispose();

    const { cache: second, warn } = makeCache(client, OPENAI_LARGE);
    await second.initialize();

    expect(warn).not.toHaveBeenCalled();
    await second.dispose();
  });
});
