/**
 * Tests for features added in v0.2.0:
 * - invalidateByModel / invalidateByCategory
 * - staleAfterModelChange
 * - rerank hook
 * - params-aware filtering (temperature/topP/seed storage)
 * - checkBatch
 * - thresholdEffectiveness
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

// Minimal mock client factory
function makeMockClient(options: {
  searchResult?: { key: string; fields: Record<string, string> };
  searchResults?: Array<{ key: string; fields: Record<string, string> }>;
} = {}) {
  const hashStore = new Map<string, Record<string, string>>();
  let searchCallCount = 0;

  const mockClient = {
    hashStore,
    call: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [
            ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']],
            ['identifier', 'binary_refs'],
          ],
        ];
      }
      if (cmd === 'FT.CREATE') return 'OK';
      if (cmd === 'FT.DROPINDEX') return 'OK';
      if (cmd === 'FT.SEARCH') {
        if (options.searchResults) {
          const result = options.searchResults[searchCallCount] ?? null;
          searchCallCount++;
          if (!result) return ['0'];
          return [
            '1',
            result.key,
            Object.entries(result.fields).flatMap(([k, v]) => [k, v]).concat(['__score', '0.01']),
          ];
        }
        if (!options.searchResult) return ['0'];
        const { key, fields } = options.searchResult;
        return [
          '1',
          key,
          Object.entries(fields).flatMap(([k, v]) => [k, v]).concat(['__score', '0.01']),
        ];
      }
      return null;
    }),
    hset: vi.fn(async (key: string, fields: Record<string, string | Buffer>) => {
      const strFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        strFields[k] = Buffer.isBuffer(v) ? '__buffer__' : String(v);
      }
      hashStore.set(key, strFields);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => hashStore.get(key) ?? {}),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (...args: unknown[]) => args.length),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [[null, 1], [null, 1]]),
      call: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zremrangebyscore: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
    })),
    zadd: vi.fn(async () => 1),
    zrange: vi.fn(async () => []),
    nodes: vi.fn(() => null),
  };

  return mockClient;
}

// --- invalidateByModel / invalidateByCategory ---

describe('invalidateByModel', () => {
  it('calls invalidate with @model:{...} filter', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_inv',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const count = await cache.invalidateByModel('gpt-4o');
    expect(count).toBe(0); // search returns 0

    // Verify FT.SEARCH was called with model filter
    const searchCall = client.call.mock.calls.find(
      (c) => c[0] === 'FT.SEARCH' && String(c[2]).includes('@model:'),
    );
    expect(searchCall).toBeDefined();
    // The filter may escape hyphens for TAG values; check for 'gpt' and '4o' separately
    const filterStr = String(searchCall?.[2]);
    expect(filterStr).toContain('gpt');
    expect(filterStr).toContain('4o');
  });
});

describe('invalidateByCategory', () => {
  it('calls invalidate with @category:{...} filter', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_inv2',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    await cache.invalidateByCategory('geography');

    const searchCall = client.call.mock.calls.find(
      (c) => c[0] === 'FT.SEARCH' && String(c[2]).includes('@category:'),
    );
    expect(searchCall).toBeDefined();
    expect(String(searchCall?.[2])).toContain('geography');
  });
});

// --- staleAfterModelChange ---

describe('staleAfterModelChange', () => {
  it('evicts entry when stored model differs from currentModel', async () => {
    const client = makeMockClient({
      searchResult: {
        key: 'test_stale:entry:abc',
        fields: { response: 'Old answer', model: 'gpt-4o', category: '' },
      },
    });
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_stale',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.check('Hello', {
      staleAfterModelChange: true,
      currentModel: 'gpt-4o-mini', // different from stored 'gpt-4o'
    });

    expect(result.hit).toBe(false);
    // Verify del was called (eviction)
    expect(client.del).toHaveBeenCalled();
  });

  it('returns hit when stored model matches currentModel', async () => {
    const client = makeMockClient({
      searchResult: {
        key: 'test_stale2:entry:abc',
        fields: { response: 'Answer', model: 'gpt-4o', category: '' },
      },
    });
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_stale2',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.check('Hello', {
      staleAfterModelChange: true,
      currentModel: 'gpt-4o', // matches stored 'gpt-4o'
    });

    expect(result.hit).toBe(true);
    expect(result.response).toBe('Answer');
  });

  it('ignores model mismatch when option disabled', async () => {
    const client = makeMockClient({
      searchResult: {
        key: 'test_stale3:entry:abc',
        fields: { response: 'Answer', model: 'gpt-4o', category: '' },
      },
    });
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_stale3',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    // Without staleAfterModelChange, model mismatch is ignored
    const result = await cache.check('Hello', { currentModel: 'gpt-4o-mini' });
    expect(result.hit).toBe(true);
  });
});

// --- rerank hook ---

describe('rerank hook', () => {
  it('uses rerankFn to pick a non-first candidate', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    // Return 3 results from FT.SEARCH
    client.call.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']]],
        ];
      }
      if (cmd === 'FT.SEARCH') {
        return [
          '3',
          'key1', ['response', 'Short answer', 'model', '', 'category', '', '__score', '0.01'],
          'key2', ['response', 'Medium answer here', 'model', '', 'category', '', '__score', '0.02'],
          'key3', ['response', 'The longest and most detailed answer in this test', 'model', '', 'category', '', '__score', '0.03'],
        ];
      }
      return null;
    });

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_rerank',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    // Rerank: pick the candidate with the longest response
    const result = await cache.check('Hello', {
      rerank: {
        k: 3,
        rerankFn: async (_query, candidates) => {
          let maxIdx = 0;
          for (let i = 1; i < candidates.length; i++) {
            if (candidates[i].response.length > candidates[maxIdx].response.length) {
              maxIdx = i;
            }
          }
          return maxIdx;
        },
      },
    });

    expect(result.hit).toBe(true);
    expect(result.response).toBe('The longest and most detailed answer in this test');
  });

  it('rerank returning -1 yields miss', async () => {
    const client = makeMockClient({
      searchResult: {
        key: 'test_rerank2:entry:abc',
        fields: { response: 'Answer', model: '', category: '' },
      },
    });
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_rerank2',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.check('Hello', {
      rerank: {
        k: 1,
        rerankFn: async () => -1,
      },
    });

    expect(result.hit).toBe(false);
    expect(result.confidence).toBe('miss');
  });

  it('rerank returning out-of-range index yields miss', async () => {
    const client = makeMockClient({
      searchResult: {
        key: 'test_rerank3:entry:abc',
        fields: { response: 'Answer', model: '', category: '' },
      },
    });
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_rerank3',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    // rerankFn returns k (one past the end of the candidates array)
    const result = await cache.check('Hello', {
      rerank: {
        k: 1,
        rerankFn: async (_q, candidates) => candidates.length, // out-of-range
      },
    });

    expect(result.hit).toBe(false);
    expect(result.confidence).toBe('miss');
  });
});

// --- params-aware filtering ---

describe('params-aware filtering', () => {
  it('stores temperature/topP/seed as numeric fields', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_params',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    await cache.store('Hello', 'Hi', {
      temperature: 0.7,
      topP: 0.9,
      seed: 42,
    });

    expect(client.hset).toHaveBeenCalled();
    // hashStore.values().next() now returns the discovery-marker entry first.
    // Find the actual cache entry by its key (contains ':entry:').
    const storedFields = [...client.hashStore.entries()]
      .find(([k]) => k.includes(':entry:'))?.[1] as Record<string, string>;
    expect(storedFields['temperature']).toBe('0.7');
    expect(storedFields['top_p']).toBe('0.9');
    expect(storedFields['seed']).toBe('42');
  });

  it('does not store params when not provided', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_noparams',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    await cache.store('Hello', 'Hi');

    const storedFields = client.hashStore.values().next().value as Record<string, string> ?? {};
    expect(storedFields['temperature']).toBeUndefined();
    expect(storedFields['top_p']).toBeUndefined();
    expect(storedFields['seed']).toBeUndefined();
  });
});

// --- thresholdEffectiveness ---

describe('thresholdEffectiveness', () => {
  it('returns insufficient_data when samples below minimum', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_thresh',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    // zrange returns empty (no window data)
    const result = await cache.thresholdEffectiveness({ minSamples: 100 });
    expect(result.recommendation).toBe('insufficient_data');
    expect(result.sampleCount).toBe(0);
  });

  it('recommends tighten_threshold when many uncertain hits', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);
    const threshold = 0.1;
    const uncertaintyBand = 0.05;

    // Create window data with many uncertain hits (score close to threshold)
    const entries = [];
    for (let i = 0; i < 120; i++) {
      // Uncertain hits: score between (threshold - band) and threshold
      const score = threshold - uncertaintyBand * 0.5; // 0.075 - in uncertain zone
      entries.push(JSON.stringify({ score, result: 'hit', category: '' }));
    }
    // A few comfortable hits
    for (let i = 0; i < 10; i++) {
      entries.push(JSON.stringify({ score: 0.02, result: 'hit', category: '' }));
    }

    client.zrange.mockResolvedValue(entries);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_thresh_tight',
      defaultThreshold: threshold,
      uncertaintyBand,
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.thresholdEffectiveness({ minSamples: 100 });
    expect(result.recommendation).toBe('tighten_threshold');
    expect(result.recommendedThreshold).toBeDefined();
    expect(result.recommendedThreshold!).toBeLessThan(threshold);
  });

  it('recommends loosen_threshold when many near-misses', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);
    const threshold = 0.1;
    const uncertaintyBand = 0.05;

    // Near-misses: misses very close to threshold (just above it, within 0.03)
    const entries = [];
    for (let i = 0; i < 80; i++) {
      const score = threshold + 0.01; // just above threshold (near miss, delta = 0.01)
      entries.push(JSON.stringify({ score, result: 'miss', category: '' }));
    }
    // Comfortable hits well below uncertainty zone (score << threshold - uncertaintyBand)
    for (let i = 0; i < 40; i++) {
      entries.push(JSON.stringify({ score: 0.02, result: 'hit', category: '' }));
    }

    client.zrange.mockResolvedValue(entries);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_thresh_loose',
      defaultThreshold: threshold,
      uncertaintyBand,
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.thresholdEffectiveness({ minSamples: 100 });
    expect(result.recommendation).toBe('loosen_threshold');
    expect(result.recommendedThreshold).toBeDefined();
    expect(result.recommendedThreshold!).toBeGreaterThan(threshold);
  });

  it('returns optimal when threshold is well-calibrated', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);
    const threshold = 0.1;

    // Good mix: low uncertain hits, low near-misses
    const entries = [];
    for (let i = 0; i < 80; i++) {
      entries.push(JSON.stringify({ score: 0.03, result: 'hit', category: '' }));
    }
    for (let i = 0; i < 40; i++) {
      entries.push(JSON.stringify({ score: 0.5, result: 'miss', category: '' })); // far misses
    }

    client.zrange.mockResolvedValue(entries);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_thresh_opt',
      defaultThreshold: threshold,
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.thresholdEffectiveness({ minSamples: 100 });
    expect(result.recommendation).toBe('optimal');
    expect(result.hitRate).toBeGreaterThan(0.5);
  });
});

// --- checkBatch ---

describe('checkBatch', () => {
  it('returns empty array for empty input', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_batch',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const results = await cache.checkBatch([]);
    expect(results).toEqual([]);
  });

  it('returns results in input order', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.5, 0.5]);

    // Mock pipeline to return mix of hits and misses
    client.pipeline.mockReturnValue({
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [
        [null, ['1', 'key1', ['response', 'Answer 1', '__score', '0.01']]],
        [null, ['0']], // miss
        [null, ['1', 'key3', ['response', 'Answer 3', '__score', '0.02']]],
      ]),
      call: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zremrangebyscore: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
    });

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn,
      name: 'test_batch2',
      embeddingCache: { enabled: false },
    });
    await cache.initialize();

    const results = await cache.checkBatch(['prompt1', 'prompt2', 'prompt3']);
    expect(results.length).toBe(3);
    expect(results[0].hit).toBe(true);
    expect(results[0].response).toBe('Answer 1');
    expect(results[1].hit).toBe(false);
    expect(results[2].hit).toBe(true);
    expect(results[2].response).toBe('Answer 3');
  });
});
