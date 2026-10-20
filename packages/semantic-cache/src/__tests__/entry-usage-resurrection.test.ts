/**
 * A cache hit must never resurrect an entry that was deleted or expired between
 * FT.SEARCH and the usage-tracking write. The usage script is guarded by
 * EXISTS, so a hit on a vanished key is a no-op — it does not recreate the hash
 * (which would come back TTL-less and untagged) and it is not logged as a
 * failure. The fake server below keeps an in-memory hash map so the emulated
 * script runs against real "exists or not" state.
 */
import { describe, it, expect, vi } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

function makeClient(existing: Set<string>) {
  const hashes = new Map<string, Record<string, string>>();
  for (const k of existing) hashes.set(k, { hit_count: '0', last_accessed_at: '0' });
  const ttls = new Map<string, number>();

  // Emulates RECORD_USAGE_LUA: touch only if the key exists.
  const evalUsage = (key: string, now: string, ttl: string): number => {
    const h = hashes.get(key);
    if (!h) return 0;
    h.hit_count = String(Number(h.hit_count) + 1);
    h.last_accessed_at = now;
    if (ttl !== '') ttls.set(key, Number(ttl));
    return 1;
  };

  const pipeline = vi.fn(() => {
    const queued: unknown[][] = [];
    const stub: Record<string, unknown> = {
      call: vi.fn((...args: unknown[]) => {
        queued.push(args);
        return stub;
      }),
      hincrby: vi.fn(() => stub),
      hset: vi.fn(() => stub),
      expire: vi.fn(() => stub),
      zadd: vi.fn(() => stub),
      zremrangebyscore: vi.fn(() => stub),
      zremrangebyrank: vi.fn(() => stub),
      exec: vi.fn(async () =>
        queued.map((a) =>
          a[0] === 'EVALSHA' || a[0] === 'EVAL'
            ? [null, evalUsage(String(a[3]), String(a[4]), String(a[5]))]
            : [null, 1],
        ),
      ),
    };
    return stub;
  });

  const client = {
    call: vi.fn(async (...args: unknown[]) => {
      if (args[0] === 'FT.INFO') {
        return [
          'attributes',
          [
            ['identifier', 'embedding', 'type', 'VECTOR', 'index', ['dimensions', '2']],
            ['identifier', 'hit_count', 'type', 'NUMERIC'],
            ['identifier', 'last_accessed_at', 'type', 'NUMERIC'],
          ],
        ];
      }
      if (args[0] === 'FT.SEARCH')
        return ['1', 't:entry:gone', ['__score', '0.01', 'response', 'r']];
      if (args[0] === 'EVALSHA' || args[0] === 'EVAL')
        return evalUsage(String(args[3]), String(args[4]), String(args[5]));
      return 'OK';
    }),
    pipeline,
    hincrby: vi.fn(),
    hset: vi.fn(async () => 1),
    expire: vi.fn(),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async () => ({})),
    del: vi.fn(async () => 1),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    zadd: vi.fn(async () => 1),
    zrange: vi.fn(async () => []),
    nodes: vi.fn(() => null),
  };
  return { client, hashes, ttls };
}

describe('usage tracking never resurrects a missing entry', () => {
  it('a hit on a key deleted/expired after FT.SEARCH does not recreate it', async () => {
    const { client, hashes, ttls } = makeClient(new Set()); // key already gone
    const logger = { warn: vi.fn() };
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: async () => [0.1, 0.2],
      name: 't',
      logger,
      embeddingCache: { enabled: false },
      discovery: { enabled: false },
      configRefresh: { enabled: false },
    });
    await cache.initialize();

    const result = await cache.check('prompt');

    expect(result.hit).toBe(true);
    expect(hashes.has('t:entry:gone')).toBe(false); // not recreated
    expect(ttls.has('t:entry:gone')).toBe(false);
    expect(client.hincrby).not.toHaveBeenCalled(); // no raw HINCRBY/HSET path left
    expect(logger.warn).not.toHaveBeenCalled(); // a missing key is not a failure
  });

  it('an existing key is still updated, with TTL refresh', async () => {
    const { client, hashes, ttls } = makeClient(new Set(['t:entry:gone']));
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: async () => [0.1, 0.2],
      name: 't',
      defaultTtl: 300,
      embeddingCache: { enabled: false },
      discovery: { enabled: false },
      configRefresh: { enabled: false },
    });
    await cache.initialize();

    await cache.check('prompt');

    expect(hashes.get('t:entry:gone')?.hit_count).toBe('1');
    expect(ttls.get('t:entry:gone')).toBe(300);
  });
});
