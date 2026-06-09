/**
 * entryAnalytics() — server-side count queries must not sample via SORTBY LIMIT.
 */
import { describe, it, expect, vi } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

const TOTAL_ENTRIES = 15_000;
const NEVER_HIT_COUNT = 12_000;
const COLD_ENTRY_COUNT = 13_000;

function makeAnalyticsMockClient() {
  const ftInfo = [
    'attributes',
    [
      ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']],
      ['identifier', 'hit_count', 'type', 'NUMERIC'],
      ['identifier', 'last_accessed_at', 'type', 'NUMERIC'],
    ],
  ];

  const call = vi.fn(async (...args: unknown[]) => {
    const cmd = args[0] as string;
    if (cmd === 'FT.INFO') return ftInfo;
    if (cmd === 'FT.CREATE') return 'OK';
    if (cmd === 'FT.DROPINDEX') return 'OK';
    if (cmd === 'FT.SEARCH') {
      const filter = String(args[2] ?? '*');
      const limitIdx = args.indexOf('LIMIT');
      const limitCount =
        limitIdx >= 0 ? Number(args[limitIdx + 2]) : Number.POSITIVE_INFINITY;
      const isCountOnly = limitCount === 0;

      if (isCountOnly) {
        if (filter === '*') return [String(TOTAL_ENTRIES)];
        if (filter === '@hit_count:[0 0]') return [String(NEVER_HIT_COUNT)];
        if (filter.startsWith('@last_accessed_at:')) return [String(COLD_ENTRY_COUNT)];
        return ['0'];
      }

      // Top-N materialization — only hot entries (would hide never-hit in a 10k sample)
      return [
        '2',
        'cache:entry:hot-1',
        ['hit_count', '500', 'last_accessed_at', '1', 'inserted_at', '1', 'category', '', 'model', ''],
        'cache:entry:hot-2',
        ['hit_count', '400', 'last_accessed_at', '2', 'inserted_at', '2', 'category', '', 'model', ''],
      ];
    }
    return null;
  });

  return {
    call,
    hset: vi.fn(async () => 1),
    hgetall: vi.fn(async () => ({})),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn().mockReturnThis(),
      hset: vi.fn().mockReturnThis(),
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

describe('entryAnalytics', () => {
  it('uses FT.SEARCH LIMIT 0 0 for counts so never-hit is correct when total > 10k', async () => {
    const client = makeAnalyticsMockClient();
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.5, 0.5]),
      name: 'test_entry_analytics',
      embeddingCache: { enabled: false },
      discovery: { enabled: false },
      configRefresh: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.entryAnalytics({ topN: 2, coldAfterDays: 7 });

    expect(result.totalEntries).toBe(TOTAL_ENTRIES);
    expect(result.neverHitCount).toBe(NEVER_HIT_COUNT);
    expect(result.coldEntryCount).toBe(COLD_ENTRY_COUNT);
    expect(result.hitAtLeastOnceCount).toBe(TOTAL_ENTRIES - NEVER_HIT_COUNT);
    expect(result.topEntries).toHaveLength(2);
    expect(result.topEntries[0].hitCount).toBe(500);

    const countCalls = client.call.mock.calls.filter(
      (c) => c[0] === 'FT.SEARCH' && c[c.indexOf('LIMIT') + 2] === '0',
    );
    expect(countCalls.length).toBeGreaterThanOrEqual(3);
    expect(countCalls.some((c) => c[2] === '*')).toBe(true);
    expect(countCalls.some((c) => c[2] === '@hit_count:[0 0]')).toBe(true);
    expect(countCalls.some((c) => String(c[2]).startsWith('@last_accessed_at:'))).toBe(
      true,
    );

    const topCalls = client.call.mock.calls.filter(
      (c) => c[0] === 'FT.SEARCH' && c.includes('SORTBY'),
    );
    expect(topCalls).toHaveLength(1);
    expect(topCalls[0]).toContain('LIMIT');
    expect(topCalls[0][topCalls[0].indexOf('LIMIT') + 2]).toBe('2');
  });
});

describe('entryAnalytics (SCAN fallback — cap at 10k)', () => {
  it('stops at ENTRY_ANALYTICS_LIMIT and does not call hgetall beyond it', async () => {
    const keys = Array.from({ length: 12_000 }, (_, i) => `scan_test:entry:${i}`);
    const client = {
      call: vi.fn(async (...args: unknown[]) => {
        const cmd = args[0] as string;
        // FT.INFO without hit_count → _hasUsageFields = false → scan path
        if (cmd === 'FT.INFO') {
          return [
            'attributes',
            [
              [
                'identifier',
                'embedding',
                'type',
                'VECTOR',
                'index',
                ['dimensions', '2'],
              ],
            ],
          ];
        }
        if (cmd === 'FT.CREATE') return 'OK';
        return null;
      }),
      hgetall: vi.fn(async () => ({})), // must NOT be called — hmget pipeline is used instead
      hset: vi.fn(async () => 1),
      hincrby: vi.fn(async () => 0),
      expire: vi.fn(async () => 1),
      del: vi.fn(async () => 1),
      scan: vi.fn(async () => ['0', keys] as [string, string[]]),
      get: vi.fn(async () => null),
      getBuffer: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
      pipeline: vi.fn(() => ({
        hmget: vi.fn().mockReturnThis(),
        exec: vi.fn(async () =>
          // Return [null, values] tuples — one per key in the batch
          Array.from({ length: Math.min(keys.length, 10_000) }, () => [
            null,
            ['0', '0', '0', '', ''], // hit_count, last_accessed_at, inserted_at, category, model
          ]),
        ),
        hincrby: vi.fn().mockReturnThis(),
        hset: vi.fn().mockReturnThis(),
      })),
      zadd: vi.fn(async () => 1),
      zrange: vi.fn(async () => []),
      nodes: vi.fn(() => null),
    };

    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
      name: 'scan_test',
      embeddingCache: { enabled: false },
      discovery: { enabled: false },
      configRefresh: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.entryAnalytics({ topN: 5 });
    expect(result.totalEntries).toBe(10_000);

    // hgetall must never be called — we use pipelined hmget for only the 5 needed fields
    expect(client.hgetall).not.toHaveBeenCalled();

    // pipeline was used (one call per SCAN batch, not per key)
    expect(client.pipeline).toHaveBeenCalled();
    const pipelineCallCount = (client.pipeline as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(pipelineCallCount).toBeLessThan(10_000);
  });
});
