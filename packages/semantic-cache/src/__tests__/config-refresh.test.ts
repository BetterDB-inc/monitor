import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SemanticCache } from '../SemanticCache';
import type { Valkey } from '../types';

function makeMockClient(initialConfig: Record<string, string> = {}) {
  let configResponse: Record<string, string> = { ...initialConfig };

  const client = {
    setConfigResponse(next: Record<string, string>) {
      configResponse = next;
    },
    failNextHgetall: false,
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
      if (cmd === 'FT.SEARCH') return ['0'];
      return null;
    }),
    hset: vi.fn(async () => 1),
    hget: vi.fn(async () => null),
    hgetall: vi.fn(async (key: string) => {
      if (client.failNextHgetall) {
        client.failNextHgetall = false;
        throw new Error('NOAUTH');
      }
      if (typeof key === 'string' && key.endsWith(':__config')) {
        return { ...configResponse };
      }
      return {};
    }),
    hincrby: vi.fn(async () => 0),
    expire: vi.fn(async () => 1),
    del: vi.fn(async () => 1),
    scan: vi.fn(async () => ['0', []]),
    get: vi.fn(async () => null),
    getBuffer: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
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

  return client;
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

describe('config refresh', () => {
  it('threshold field updates defaultThreshold from constructor value', async () => {
    const client = makeMockClient({ threshold: '0.05' });
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
      name: 'cfg_test',
      defaultThreshold: 0.10,
      embeddingCache: { enabled: false },
    });
    await cache.initialize();
    await flushMicrotasks(5);
    expect(cache._defaultThreshold).toBeCloseTo(0.05);
  });

  it('threshold:{category} field populates per-category override', async () => {
    const client = makeMockClient({
      threshold: '0.10',
      'threshold:faq': '0.07',
      'threshold:support': '0.12',
    });
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
      name: 'cfg_categories',
      defaultThreshold: 0.10,
      embeddingCache: { enabled: false },
    });
    await cache.initialize();
    await flushMicrotasks(5);
    expect(cache._categoryThresholds['faq']).toBeCloseTo(0.07);
    expect(cache._categoryThresholds['support']).toBeCloseTo(0.12);
  });

  it('falls back to constructor values when __config is empty', async () => {
    const client = makeMockClient({});
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
      name: 'cfg_fallback',
      defaultThreshold: 0.15,
      categoryThresholds: { faq: 0.08 },
      embeddingCache: { enabled: false },
    });
    await cache.initialize();
    await flushMicrotasks(5);
    expect(cache._defaultThreshold).toBeCloseTo(0.15);
    expect(cache._categoryThresholds['faq']).toBeCloseTo(0.08);
  });

  it('ignores non-numeric values', async () => {
    const client = makeMockClient({ threshold: 'not a number' });
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
      name: 'cfg_nan',
      defaultThreshold: 0.20,
      embeddingCache: { enabled: false },
    });
    await cache.initialize();
    await flushMicrotasks(5);
    expect(cache._defaultThreshold).toBeCloseTo(0.20);
  });

  it('ignores out-of-range values', async () => {
    const client = makeMockClient({
      threshold: '-0.1',
      'threshold:faq': '2.5',
    });
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
      name: 'cfg_range',
      defaultThreshold: 0.20,
      categoryThresholds: { faq: 0.10 },
      embeddingCache: { enabled: false },
    });
    await cache.initialize();
    await flushMicrotasks(5);
    expect(cache._defaultThreshold).toBeCloseTo(0.20);
    expect(cache._categoryThresholds['faq']).toBeCloseTo(0.10);
  });

  it('refreshes on the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient({ threshold: '0.10' });
      const cache = new SemanticCache({
        client: client as unknown as Valkey,
        embedFn: vi.fn(async () => [0.1, 0.2]),
        name: 'cfg_interval',
        defaultThreshold: 0.10,
        configRefresh: { intervalMs: 2000 },
        embeddingCache: { enabled: false },
      });
      await cache.initialize();
      await flushMicrotasks(5);

      client.setConfigResponse({ threshold: '0.05' });
      vi.advanceTimersByTime(2000);
      await flushMicrotasks(5);
      expect(cache._defaultThreshold).toBeCloseTo(0.05);

      client.setConfigResponse({ threshold: '0.08' });
      vi.advanceTimersByTime(2000);
      await flushMicrotasks(5);
      expect(cache._defaultThreshold).toBeCloseTo(0.08);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start the timer when configRefresh.enabled is false', async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient({ threshold: '0.05' });
      const cache = new SemanticCache({
        client: client as unknown as Valkey,
        embedFn: vi.fn(async () => [0.1, 0.2]),
        name: 'cfg_disabled',
        defaultThreshold: 0.20,
        configRefresh: { enabled: false },
        embeddingCache: { enabled: false },
      });
      await cache.initialize();
      await flushMicrotasks(5);
      expect(cache._defaultThreshold).toBeCloseTo(0.20);

      vi.advanceTimersByTime(60_000);
      await flushMicrotasks(5);
      expect(cache._defaultThreshold).toBeCloseTo(0.20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps intervalMs to 1000ms minimum', async () => {
    const client = makeMockClient();
    const cache = new SemanticCache({
      client: client as unknown as Valkey,
      embedFn: vi.fn(async () => [0.1, 0.2]),
      name: 'cfg_clamp',
      configRefresh: { intervalMs: 100 },
      embeddingCache: { enabled: false },
    });
    await cache.initialize();
    expect(cache._configRefreshIntervalMs).toBe(1000);
  });

  it('clears the timer in shutdown()', async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      const cache = new SemanticCache({
        client: client as unknown as Valkey,
        embedFn: vi.fn(async () => [0.1, 0.2]),
        name: 'cfg_shutdown',
        configRefresh: { intervalMs: 1000 },
        embeddingCache: { enabled: false },
      });
      await cache.initialize();
      await flushMicrotasks(5);
      const before = client.hgetall.mock.calls.length;

      await cache.shutdown();
      vi.advanceTimersByTime(60_000);
      await flushMicrotasks(5);
      expect(client.hgetall.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer in dispose()', async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient();
      const cache = new SemanticCache({
        client: client as unknown as Valkey,
        embedFn: vi.fn(async () => [0.1, 0.2]),
        name: 'cfg_dispose',
        configRefresh: { intervalMs: 1000 },
        embeddingCache: { enabled: false },
      });
      await cache.initialize();
      await flushMicrotasks(5);
      const before = client.hgetall.mock.calls.length;

      await cache.dispose();
      vi.advanceTimersByTime(60_000);
      await flushMicrotasks(5);
      expect(client.hgetall.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a category override when it disappears from the hash', async () => {
    vi.useFakeTimers();
    try {
      const client = makeMockClient({
        threshold: '0.10',
        'threshold:faq': '0.07',
      });
      const cache = new SemanticCache({
        client: client as unknown as Valkey,
        embedFn: vi.fn(async () => [0.1, 0.2]),
        name: 'cfg_remove_cat',
        defaultThreshold: 0.10,
        configRefresh: { intervalMs: 1000 },
        embeddingCache: { enabled: false },
      });
      await cache.initialize();
      await flushMicrotasks(5);
      expect(cache._categoryThresholds['faq']).toBeCloseTo(0.07);

      // Simulate external HDEL of the faq override
      client.setConfigResponse({ threshold: '0.10' });
      vi.advanceTimersByTime(1000);
      await flushMicrotasks(5);
      // faq has no constructor override, so it's removed entirely
      expect(cache._categoryThresholds['faq']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
