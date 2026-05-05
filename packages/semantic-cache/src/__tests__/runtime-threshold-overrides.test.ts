/**
 * Tests for v0.4.0 runtime threshold overrides.
 *
 * SemanticCache.check() reads HGETALL {prefix}:__config and uses any
 * `threshold` / `threshold:{category}` field as a runtime override on top of
 * the constructor-set categoryThresholds. See
 * docs/plans/specs/spec-semantic-cache-runtime-threshold-reads.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

// FT.SEARCH always returns a candidate with score 0.01 (cosine distance),
// so a threshold of 0.1 → hit, a threshold of 0.005 → miss.
const CANDIDATE_SCORE_STR = '0.01';

function makeClient(initialConfigHash: Record<string, string> = {}) {
  const hashStore = new Map<string, Record<string, string>>();
  hashStore.set('test_cache:__config', { ...initialConfigHash });

  const client = {
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
      if (cmd === 'FT.CREATE' || cmd === 'FT.DROPINDEX') {
        return 'OK';
      }
      if (cmd === 'FT.SEARCH') {
        return [
          '1',
          'test_cache:entry:abc',
          [
            'prompt',
            'q',
            'response',
            'r',
            'model',
            'm',
            '__score',
            CANDIDATE_SCORE_STR,
          ],
        ];
      }
      return null;
    }),
    hset: vi.fn(async (key: string, fields: Record<string, string>) => {
      const existing = hashStore.get(key) ?? {};
      hashStore.set(key, { ...existing, ...fields });
      return 1;
    }),
    hgetall: vi.fn(async (key: string) => ({ ...(hashStore.get(key) ?? {}) })),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (...args: unknown[]) => args.length),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    pipeline: vi.fn(() => ({
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn(async () => [
        [null, 1],
        [null, 1],
      ]),
      call: vi.fn().mockReturnThis(),
      zadd: vi.fn().mockReturnThis(),
      zremrangebyscore: vi.fn().mockReturnThis(),
      zremrangebyrank: vi.fn().mockReturnThis(),
    })),
    zadd: vi.fn(async () => 1),
    zrange: vi.fn(async () => []),
    nodes: vi.fn(() => null),
  };

  return { client, hashStore };
}

function buildCache(client: ReturnType<typeof makeClient>['client'], extra: Record<string, unknown> = {}) {
  return new SemanticCache({
    client: client as unknown as Valkey,
    embedFn: vi.fn(async () => [0.5, 0.5]),
    name: 'test_cache',
    defaultThreshold: 0.1,
    embeddingCache: { enabled: false },
    ...extra,
  });
}

describe('runtime threshold overrides', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('uses constructor defaults when {prefix}:__config is empty', async () => {
    const { client } = makeClient({});
    const cache = buildCache(client);
    await cache.initialize();

    const result = await cache.check('hello');
    expect(result.hit).toBe(true); // 0.01 <= default 0.1
  });

  it('honors a global threshold override from the config hash', async () => {
    const { client } = makeClient({ threshold: '0.005' });
    const cache = buildCache(client);
    await cache.initialize();

    const result = await cache.check('hello');
    expect(result.hit).toBe(false); // 0.01 > 0.005
  });

  it('per-category override beats the global override for that category', async () => {
    const { client } = makeClient({
      threshold: '0.5', // permissive global → would hit
      'threshold:strict': '0.005', // strict for this category → miss
    });
    const cache = buildCache(client);
    await cache.initialize();

    const strictResult = await cache.check('hello', { category: 'strict' });
    expect(strictResult.hit).toBe(false);

    const otherResult = await cache.check('hello', { category: 'lax' });
    expect(otherResult.hit).toBe(true); // falls through to global 0.5
  });

  it('options.threshold beats every runtime override', async () => {
    const { client } = makeClient({ threshold: '0.5' });
    const cache = buildCache(client);
    await cache.initialize();

    const result = await cache.check('hello', { threshold: 0.005 });
    expect(result.hit).toBe(false);
  });

  it('caches the config-hash read for 5s and refreshes after TTL', async () => {
    vi.useFakeTimers();
    const { client, hashStore } = makeClient({ threshold: '0.5' });
    const cache = buildCache(client);
    await cache.initialize();

    await cache.check('a');
    await cache.check('b');
    await cache.check('c');

    const configReads = client.hgetall.mock.calls.filter(
      (c) => c[0] === 'test_cache:__config',
    );
    expect(configReads).toHaveLength(1);

    // After TTL, an external HSET takes effect on the next check
    hashStore.set('test_cache:__config', { threshold: '0.005' });
    vi.advanceTimersByTime(5_001);

    const result = await cache.check('d');
    expect(result.hit).toBe(false);
    const configReadsAfter = client.hgetall.mock.calls.filter(
      (c) => c[0] === 'test_cache:__config',
    );
    expect(configReadsAfter.length).toBeGreaterThan(1);
  });

  it('falls back to constructor categoryThresholds when HGETALL throws', async () => {
    const { client } = makeClient();
    client.hgetall = vi.fn(async (key: string) => {
      if (key === 'test_cache:__config') {
        throw new Error('valkey unreachable');
      }
      return {};
    });

    const cache = buildCache(client, {
      categoryThresholds: { strict: 0.005 },
    });
    await cache.initialize();

    const result = await cache.check('hello', { category: 'strict' });
    expect(result.hit).toBe(false); // constructor value used
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/test_cache.*test_cache:__config.*valkey unreachable/),
    );
  });

  it('drops out-of-range values and falls through', async () => {
    const { client } = makeClient({
      threshold: '99', // > 2, dropped
      'threshold:bad': 'not-a-number', // unparseable, dropped
    });
    const cache = buildCache(client, {
      categoryThresholds: { bad: 0.005 },
    });
    await cache.initialize();

    const badResult = await cache.check('hello', { category: 'bad' });
    expect(badResult.hit).toBe(false); // falls back to constructor 0.005
    expect(warnSpy).toHaveBeenCalled();
  });
});
