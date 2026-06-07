/**
 * Unit tests for LLM-as-judge adjudication (CacheCheckOptions.judge).
 *
 * Fixture scores with defaultThreshold=0.10, uncertaintyBand=0.05:
 *   high-confidence:  __score = 0.02  (score <= 0.05 = threshold - band)
 *   borderline:       __score = 0.08  (0.05 < score <= 0.10)
 *   miss:             FT.SEARCH returns 0 rows
 */
import { describe, it, expect, vi } from 'vitest';
import { Registry } from 'prom-client';
import { SemanticCache } from '../SemanticCache';
import { SemanticCacheUsageError } from '../errors';
import type { Valkey } from '../types';

const THRESHOLD = 0.10;
const BAND = 0.05;
const HIGH_SCORE = '0.02';
const BORDERLINE_SCORE = '0.08';

function makeMockClient(score: string, response = 'Cached response', noResult = false) {
  const hashStore = new Map<string, Record<string, string>>();
  return {
    hashStore,
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
        if (noResult) return ['0'];
        return [
          '1',
          'test_judge:entry:abc',
          ['response', response, 'model', '', 'category', '', '__score', score],
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
    del: vi.fn(async () => 1),
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
}

async function makeCache(
  client: ReturnType<typeof makeMockClient>,
  registry: Registry,
  name = 'test_judge',
) {
  const cache = new SemanticCache({
    client: client as unknown as Valkey,
    embedFn: vi.fn(async () => [0.5, 0.5]),
    name,
    defaultThreshold: THRESHOLD,
    uncertaintyBand: BAND,
    embeddingCache: { enabled: false },
    telemetry: { registry },
  });
  await cache.initialize();
  return cache;
}

async function getCounterValue(
  registry: Registry,
  metricName: string,
  labelDecision: string,
): Promise<number> {
  const data = await registry.getMetricsAsJSON();
  const metric = data.find((m) => m.name === metricName);
  if (!metric) return 0;
  const entry = (
    metric.values as Array<{ labels: Record<string, string>; value: number }>
  ).find((v) => v.labels['decision'] === labelDecision);
  return entry?.value ?? 0;
}

// --- Test 1: accept on borderline hit ---

describe('judge: accept on borderline hit', () => {
  it('promotes to confidence: high and increments accept counter', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);
    const cache = await makeCache(client, registry);
    const judgeFn = vi.fn(async () => true);

    const result = await cache.check('hello', { judge: { judgeFn } });

    expect(result.hit).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.similarity).toBeCloseTo(0.08, 5);
    expect(judgeFn).toHaveBeenCalledOnce();

    const count = await getCounterValue(
      registry,
      'semantic_cache_judge_decisions_total',
      'accept',
    );
    expect(count).toBe(1);
  });
});

// --- Test 2: reject on borderline hit ---

describe('judge: reject on borderline hit', () => {
  it('returns miss with nearestMiss and deltaToThreshold <= 0', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);
    const cache = await makeCache(client, registry);
    const judgeFn = vi.fn(async () => false);

    const result = await cache.check('hello', { judge: { judgeFn } });

    expect(result.hit).toBe(false);
    expect(result.confidence).toBe('miss');
    expect(result.similarity).toBeCloseTo(0.08, 5); // top-level similarity present on judge-rejection
    expect(result.nearestMiss).toBeDefined();
    expect(result.nearestMiss!.similarity).toBeCloseTo(0.08, 5);
    expect(result.nearestMiss!.deltaToThreshold).toBeLessThanOrEqual(0);

    const count = await getCounterValue(
      registry,
      'semantic_cache_judge_decisions_total',
      'reject',
    );
    expect(count).toBe(1);
  });
});

// --- Test 3: NOT invoked on high-confidence hit ---

describe('judge: NOT invoked on high-confidence hit', () => {
  it('does not call judgeFn when score is below uncertainty band', async () => {
    const registry = new Registry();
    const client = makeMockClient(HIGH_SCORE);
    const cache = await makeCache(client, registry);
    const judgeFn = vi.fn(async () => true);

    const result = await cache.check('hello', { judge: { judgeFn } });

    expect(result.hit).toBe(true);
    expect(result.confidence).toBe('high');
    expect(judgeFn).not.toHaveBeenCalled();

    const count = await getCounterValue(
      registry,
      'semantic_cache_judge_decisions_total',
      'accept',
    );
    expect(count).toBe(0);
  });
});

// --- Test 4: NOT invoked on miss (no rows) ---

describe('judge: NOT invoked when FT.SEARCH returns zero rows', () => {
  it('returns miss without calling judgeFn', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE, 'Cached response', true); // noResult=true
    const cache = await makeCache(client, registry);
    const judgeFn = vi.fn(async () => true);

    const result = await cache.check('hello', { judge: { judgeFn } });

    expect(result.hit).toBe(false);
    expect(judgeFn).not.toHaveBeenCalled();
  });
});


// --- Test 6: error with onError='accept' ---

describe('judge error with onError=accept', () => {
  it('returns hit with confidence: uncertain (not promoted) and error_accept counter', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);
    const cache = await makeCache(client, registry, 'test_judge_err_acc');
    const judgeFn = vi.fn(async () => { throw new Error('LLM unavailable'); });

    const result = await cache.check('hello', {
      judge: { judgeFn, onError: 'accept' },
    });

    expect(result.hit).toBe(true);
    expect(result.confidence).toBe('uncertain');

    const count = await getCounterValue(
      registry,
      'semantic_cache_judge_decisions_total',
      'error_accept',
    );
    expect(count).toBe(1);
  });
});

// --- Test 7: error with onError='reject' ---

describe('judge error with onError=reject', () => {
  it('returns miss and increments error_reject counter', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);
    const cache = await makeCache(client, registry, 'test_judge_err_rej');
    const judgeFn = vi.fn(async () => { throw new Error('LLM unavailable'); });

    const result = await cache.check('hello', {
      judge: { judgeFn, onError: 'reject' },
    });

    expect(result.hit).toBe(false);

    const count = await getCounterValue(
      registry,
      'semantic_cache_judge_decisions_total',
      'error_reject',
    );
    expect(count).toBe(1);
  });
});

// --- Test 8: timeout with onError='accept' ---

describe('judge timeout with onError=accept', () => {
  it('returns hit with confidence: uncertain and timeout_accept counter', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);
    const cache = await makeCache(client, registry, 'test_judge_to_acc');
    const judgeFn = vi.fn(() => new Promise<boolean>(() => {})); // never resolves

    const result = await cache.check('hello', {
      judge: { judgeFn, onError: 'accept', timeoutMs: 50 },
    });

    expect(result.hit).toBe(true);
    expect(result.confidence).toBe('uncertain');

    const count = await getCounterValue(
      registry,
      'semantic_cache_judge_decisions_total',
      'timeout_accept',
    );
    expect(count).toBe(1);
  });
});

// --- Test 9: timeout with onError='reject' ---

describe('judge timeout with onError=reject', () => {
  it('returns miss and increments timeout_reject counter', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);
    const cache = await makeCache(client, registry, 'test_judge_to_rej');
    const judgeFn = vi.fn(() => new Promise<boolean>(() => {}));

    const result = await cache.check('hello', {
      judge: { judgeFn, onError: 'reject', timeoutMs: 50 },
    });

    expect(result.hit).toBe(false);

    const count = await getCounterValue(
      registry,
      'semantic_cache_judge_decisions_total',
      'timeout_reject',
    );
    expect(count).toBe(1);
  });
});

// --- Test 10: composes with rerank ---

describe('judge composes with rerank', () => {
  it('passes the rerank-winner response and score to judgeFn, not the top-1', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);

    // Override FT.SEARCH to return 3 candidates all in the borderline band
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
          'key0', ['response', 'Response zero', 'model', '', 'category', '', '__score', '0.08'],
          'key1', ['response', 'Response one', 'model', '', 'category', '', '__score', '0.09'],
          'key2', ['response', 'Response two', 'model', '', 'category', '', '__score', '0.07'],
        ];
      }
      return null;
    });

    const cache = await makeCache(client, registry, 'test_judge_rerank');

    // Rerank always picks index 1 (Response one, score 0.09)
    const rerankFn = vi.fn(async () => 1);
    const capturedInputs: Array<{ response: string; similarity: number }> = [];
    const judgeFn = vi.fn(async (input: { prompt: string; response: string; similarity: number }) => {
      capturedInputs.push(input);
      return true;
    });

    await cache.check('hello', {
      rerank: { k: 3, rerankFn },
      judge: { judgeFn },
    });

    expect(judgeFn).toHaveBeenCalledOnce();
    expect(capturedInputs[0].response).toBe('Response one');
    expect(capturedInputs[0].similarity).toBeCloseTo(0.09, 5);
  });

  it('rerank winner rejected by judge returns miss with deltaToThreshold <= 0', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);

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
          'key0', ['response', 'Response zero', 'model', '', 'category', '', '__score', '0.08'],
          'key1', ['response', 'Response one', 'model', '', 'category', '', '__score', '0.09'],
          'key2', ['response', 'Response two', 'model', '', 'category', '', '__score', '0.07'],
        ];
      }
      return null;
    });

    const cache = await makeCache(client, registry, 'test_judge_rerank_reject');

    // Rerank picks index 1 (Response one, score 0.09), judge rejects it
    const rerankFn = vi.fn(async () => 1);
    const judgeFn = vi.fn(async () => false);

    const result = await cache.check('hello', {
      rerank: { k: 3, rerankFn },
      judge: { judgeFn },
    });

    expect(result.hit).toBe(false);
    expect(result.nearestMiss).toBeDefined();
    expect(result.nearestMiss!.deltaToThreshold).toBeLessThanOrEqual(0);
    // Verify judge saw the reranked pick (index 1), not top-1
    expect(judgeFn).toHaveBeenCalledWith(
      expect.objectContaining({ response: 'Response one', similarity: expect.closeTo(0.09, 5) }),
    );
  });
});

// --- Test 11: judgeFn receives correct inputs ---

describe('judgeFn receives correct inputs', () => {
  it('sees prompt text, cached response, cosine distance, threshold, and category', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE, 'The answer is 42');
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.5, 0.5]),
      name: 'test_judge_inputs',
      defaultThreshold: THRESHOLD,
      uncertaintyBand: BAND,
      embeddingCache: { enabled: false },
      telemetry: { registry },
    });
    await cache.initialize();

    const capturedInput = vi.fn(async () => true);

    await cache.check('What is the answer?', {
      category: 'trivia',
      judge: { judgeFn: capturedInput },
    });

    expect(capturedInput).toHaveBeenCalledWith({
      prompt: 'What is the answer?',
      response: 'The answer is 42',
      similarity: expect.closeTo(0.08, 5),
      threshold: THRESHOLD,
      category: 'trivia',
      // Reserved for consumer judge functions; falls back to '' when the stored entry has no prompt field.
      cachedPrompt: '',
    });
  });
});

// --- Test 12: checkBatch with judge throws SemanticCacheUsageError ---

describe('checkBatch with judge throws SemanticCacheUsageError', () => {
  it('throws with message mentioning judge and pointing to check()', async () => {
    const registry = new Registry();
    const client = makeMockClient(BORDERLINE_SCORE);
    const cache = await makeCache(client, registry, 'test_judge_batch');

    await expect(
      cache.checkBatch(['hello'], {
        judge: { judgeFn: async () => true },
      }),
    ).rejects.toThrow(SemanticCacheUsageError);

    await expect(
      cache.checkBatch(['hello'], {
        judge: { judgeFn: async () => true },
      }),
    ).rejects.toThrow(/judge/);

    await expect(
      cache.checkBatch(['hello'], {
        judge: { judgeFn: async () => true },
      }),
    ).rejects.toThrow(/check\(\)/);
  });
});
