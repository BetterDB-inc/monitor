import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_COST_TABLE } from '../defaultCostTable';
import type { ModelCost } from '../types';

// --- DEFAULT_COST_TABLE tests ---

describe('DEFAULT_COST_TABLE', () => {
  it('is a non-empty record', () => {
    expect(typeof DEFAULT_COST_TABLE).toBe('object');
    expect(Object.keys(DEFAULT_COST_TABLE).length).toBeGreaterThan(0);
  });

  it('every entry has inputPer1k and outputPer1k as numbers', () => {
    const entries = Object.values(DEFAULT_COST_TABLE).slice(0, 20);
    for (const entry of entries) {
      expect(typeof (entry as ModelCost).inputPer1k).toBe('number');
      expect(typeof (entry as ModelCost).outputPer1k).toBe('number');
    }
  });

  it('contains well-known models', () => {
    const keys = Object.keys(DEFAULT_COST_TABLE);
    // Should contain at least some Claude or GPT model
    const hasKnownModel = keys.some(
      (k) => k.includes('gpt') || k.includes('claude') || k.includes('gemini'),
    );
    expect(hasKnownModel).toBe(true);
  });
});

// --- Cost tracking integration tests ---
// These tests use a mock Valkey client to verify cost_micros storage and retrieval
// without requiring a live Valkey connection.

import { SemanticCache } from '../SemanticCache';

function makeMockClient() {
  const store = new Map<string, Map<string, string>>();
  const hashStore = new Map<string, Record<string, string>>();

  return {
    store,
    hashStore,
    call: vi.fn(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.CREATE') return 'OK';
      if (cmd === 'FT.INFO') {
        // Return mock index info with dimension 3
        return [
          'attributes',
          [
            ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '3']],
            ['identifier', 'binary_refs'],
          ],
        ];
      }
      if (cmd === 'FT.SEARCH') {
        // Return mock search result with cost_micros
        const storedEntries = [...hashStore.entries()];
        if (storedEntries.length === 0) return ['0'];
        const [key, fields] = storedEntries[0];
        return [
          '1',
          key,
          Object.entries(fields).flatMap(([k, v]) => [k, v]).concat(['__score', '0.05']),
        ];
      }
      if (cmd === 'FT.DROPINDEX') return 'OK';
      return null;
    }),
    hset: vi.fn(async (key: string, fields: Record<string, string | Buffer>) => {
      const strFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (Buffer.isBuffer(v)) {
          strFields[k] = '__buffer__';
        } else {
          strFields[k] = String(v);
        }
      }
      hashStore.set(key, strFields);
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => {
      return hashStore.get(key) ?? {};
    }),
    hincrby: vi.fn(async (key: string, field: string, by: number) => {
      const existing = hashStore.get(key) ?? {};
      const current = parseInt(existing[field] ?? '0', 10);
      existing[field] = String(current + by);
      hashStore.set(key, existing);
      return current + by;
    }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => []),
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

describe('cost tracking - SemanticCache', () => {
  it('store() with inputTokens/outputTokens/model computes and stores cost_micros', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);

    const cache = new SemanticCache({
      client: client as unknown as import('../types').Valkey,
      embedFn,
      name: 'test_cost',
      useDefaultCostTable: false,
      costTable: {
        'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01 },
      },
    });

    // Initialize: FT.INFO throws, so FT.CREATE is called
    client.call.mockImplementationOnce(async (...args: unknown[]) => {
      if (args[0] === 'FT.INFO') throw new Error('no such index');
    });
    client.call.mockImplementationOnce(async () => 'OK'); // FT.CREATE

    await cache.initialize();

    await cache.store('What is 2+2?', 'Four', {
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
    });

    // Verify hset was called with cost_micros.
    // calls[0] is the discovery-marker registration (3-arg hset: key, field, value).
    // The entry store call uses the 2-arg form (key, fields-object) — find it by
    // checking that the second argument is a plain object, not a string.
    expect(client.hset).toHaveBeenCalled();
    const hsetArgs = client.hset.mock.calls.find(
      ([, arg]) => typeof arg === 'object' && arg !== null,
    );
    const fields = hsetArgs?.[1] as Record<string, string>;
    expect(fields['cost_micros']).toBeDefined();

    // cost = (10 * 0.0025/1000 + 5 * 0.01/1000) * 1_000_000
    //      = (0.000025 + 0.00005) * 1_000_000
    //      = 75 microdollars
    expect(parseInt(fields['cost_micros'], 10)).toBe(75);
  });

  it('store() without model does not store cost_micros', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);

    const cache = new SemanticCache({
      client: client as unknown as import('../types').Valkey,
      embedFn,
      name: 'test_no_cost',
    });

    client.call.mockImplementationOnce(async () => {
      throw new Error('no such index');
    });
    client.call.mockImplementationOnce(async () => 'OK');

    await cache.initialize();
    await cache.store('Hello', 'Hi', { inputTokens: 5, outputTokens: 2 });

    const fields = client.hset.mock.calls[0]?.[1] as Record<string, string> ?? {};
    expect(fields['cost_micros']).toBeUndefined();
  });

  it('useDefaultCostTable: false disables the bundled table', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);

    const cache = new SemanticCache({
      client: client as unknown as import('../types').Valkey,
      embedFn,
      name: 'test_no_default',
      useDefaultCostTable: false,
    });

    client.call.mockImplementationOnce(async () => {
      throw new Error('no such index');
    });
    client.call.mockImplementationOnce(async () => 'OK');

    await cache.initialize();

    // Even with a known model, no cost should be computed when useDefaultCostTable=false
    await cache.store('Hello', 'Hi', {
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 100,
    });

    const fields = client.hset.mock.calls[0]?.[1] as Record<string, string> ?? {};
    expect(fields['cost_micros']).toBeUndefined();
  });

  it('check() hit with cost_micros present returns costSaved', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);

    // Pre-seed the hash store with a known entry
    const entryKey = 'test_cost2:entry:abc123';
    client.hashStore.set(entryKey, {
      response: 'Four',
      model: 'gpt-4o',
      category: '',
      cost_micros: '500',
    });

    // Override FT.SEARCH to return this specific entry
    client.call.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [
            ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '3']],
            ['identifier', 'binary_refs'],
          ],
        ];
      }
      if (cmd === 'FT.SEARCH') {
        return [
          '1',
          entryKey,
          ['response', 'Four', 'model', 'gpt-4o', 'category', '', 'cost_micros', '500', '__score', '0.02'],
        ];
      }
      return null;
    });

    const cache = new SemanticCache({
      client: client as unknown as import('../types').Valkey,
      embedFn,
      name: 'test_cost2',
    });

    await cache.initialize();

    const result = await cache.check('What is 2+2?');

    expect(result.hit).toBe(true);
    expect(result.costSaved).toBeDefined();
    expect(result.costSaved).toBeCloseTo(0.0005, 6); // 500 microdollars = $0.0005
  });

  it('check() hit with no cost_micros does not set costSaved', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);

    const entryKey = 'test_nocost:entry:abc123';

    client.call.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '3']]],
        ];
      }
      if (cmd === 'FT.SEARCH') {
        return ['1', entryKey, ['response', 'Four', 'model', 'gpt-4o', '__score', '0.02']];
      }
      return null;
    });

    const cache = new SemanticCache({
      client: client as unknown as import('../types').Valkey,
      embedFn,
      name: 'test_nocost',
    });

    await cache.initialize();

    const result = await cache.check('What is 2+2?');

    expect(result.hit).toBe(true);
    expect(result.costSaved).toBeUndefined();
  });

  it('stats() returns costSavedMicros', async () => {
    const client = makeMockClient();
    const embedFn = vi.fn(async () => [0.1, 0.2, 0.3]);

    client.hashStore.set('test_stats:__stats', {
      hits: '5',
      misses: '3',
      total: '8',
      cost_saved_micros: '2500',
    });

    client.call.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'FT.INFO') {
        return [
          'attributes',
          [['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '3']]],
        ];
      }
      return null;
    });

    const cache = new SemanticCache({
      client: client as unknown as import('../types').Valkey,
      embedFn,
      name: 'test_stats',
    });

    await cache.initialize();

    const stats = await cache.stats();
    expect(stats.costSavedMicros).toBe(2500);
    expect(stats.hits).toBe(5);
  });
});
