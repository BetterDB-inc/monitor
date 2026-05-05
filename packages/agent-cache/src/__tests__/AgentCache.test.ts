import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Registry } from 'prom-client';
import { AgentCache } from '../AgentCache';
import { DEFAULT_COST_TABLE } from '../defaultCostTable';

const { createAnalyticsMock } = vi.hoisted(() => ({
  createAnalyticsMock: vi.fn(),
}));

vi.mock('../analytics', () => ({
  createAnalytics: createAnalyticsMock,
  NOOP_ANALYTICS: {
    init: async () => {},
    capture: () => {},
    shutdown: async () => {},
  },
}));

function createMockValkeyClient() {
  return {
    hgetall: vi.fn().mockResolvedValue({}),
  };
}

function createFullMockClient() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    scan: vi.fn().mockResolvedValue(['0', []]),
    hgetall: vi.fn().mockResolvedValue({}),
    pipeline: vi.fn(() => ({
      get: vi.fn().mockReturnThis(),
      del: vi.fn().mockReturnThis(),
      hincrby: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    })),
  };
}

async function flushMicrotasks(count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

describe('AgentCache', () => {
  beforeEach(() => {
    vi.resetModules();
    createAnalyticsMock.mockReset();
  });

  it('shuts down a late analytics client when shutdown was already called', async () => {
    const analyticsShutdown = vi.fn().mockResolvedValue(undefined);
    const analyticsInit = vi.fn().mockResolvedValue(undefined);

    let resolveAnalytics!: (value: {
      init: typeof analyticsInit;
      capture: ReturnType<typeof vi.fn>;
      shutdown: typeof analyticsShutdown;
    }) => void;

    createAnalyticsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAnalytics = resolve;
        }),
    );

    const { AgentCache: FreshAgentCache } = await import('../AgentCache');
    const cache = new FreshAgentCache({
      client: createMockValkeyClient() as any,
      analytics: { apiKey: 'phc_test_key' },
    });

    await cache.shutdown();

    resolveAnalytics({
      init: analyticsInit,
      capture: vi.fn(),
      shutdown: analyticsShutdown,
    });

    await flushMicrotasks();

    expect(analyticsInit).not.toHaveBeenCalled();
    expect(analyticsShutdown).toHaveBeenCalledTimes(1);
  });

  it('ensureDiscoveryReady() rejects on cross-type collision even when awaited before the registration promise settles', async () => {
    createAnalyticsMock.mockResolvedValue({
      init: vi.fn().mockResolvedValue(undefined),
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });

    const existingMarker = JSON.stringify({
      type: 'semantic_cache',
      prefix: 'collision-test',
      version: '0.2.0',
      protocol_version: 1,
    });
    const client = {
      hget: vi.fn().mockResolvedValue(existingMarker),
      hset: vi.fn().mockResolvedValue(1),
      hgetall: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(0),
    };

    const cache = new AgentCache({
      client: client as any,
      name: 'collision-test',
      discovery: { heartbeatIntervalMs: 999_999 },
    });

    // Call before the fire-and-forget promise settles. The .catch() handler
    // in registerDiscovery resolves discoveryReady with undefined, so the
    // await alone would not surface the collision — ensureDiscoveryReady
    // must re-check discoveryError after the await.
    await expect(cache.ensureDiscoveryReady()).rejects.toThrow(/semantic_cache/);

    // A second call still throws — the error is captured, not one-shot.
    await expect(cache.ensureDiscoveryReady()).rejects.toThrow(/semantic_cache/);
  });
});

describe('AgentCache config refresh', () => {
  beforeEach(() => {
    createAnalyticsMock.mockResolvedValue({
      init: vi.fn().mockResolvedValue(undefined),
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    createAnalyticsMock.mockReset();
  });

  it('runs a synchronous first refresh during construction', async () => {
    const client = createFullMockClient();
    new AgentCache({ client: client as any });
    await flushMicrotasks(5);
    expect(client.hgetall).toHaveBeenCalledWith(expect.stringContaining('__tool_policies'));
  });

  it('refreshes policies on the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const client = createFullMockClient();
      new AgentCache({
        client: client as any,
        configRefresh: { intervalMs: 5000 },
      });
      await flushMicrotasks(5);
      const initialCalls = (client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length;

      vi.advanceTimersByTime(5000);
      await flushMicrotasks(5);
      expect((client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(initialCalls);

      const afterFirstTick = (client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length;
      vi.advanceTimersByTime(5000);
      await flushMicrotasks(5);
      expect((client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(afterFirstTick);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start the timer when configRefresh.enabled is false', async () => {
    vi.useFakeTimers();
    try {
      const client = createFullMockClient();
      new AgentCache({
        client: client as any,
        configRefresh: { enabled: false },
      });
      await flushMicrotasks(5);
      const policyCalls = (client.hgetall as ReturnType<typeof vi.fn>).mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('__tool_policies'),
      );
      expect(policyCalls.length).toBe(0);

      vi.advanceTimersByTime(60_000);
      await flushMicrotasks(5);
      const policyCallsAfter = (client.hgetall as ReturnType<typeof vi.fn>).mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('__tool_policies'),
      );
      expect(policyCallsAfter.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps intervalMs to a 1000ms minimum', async () => {
    vi.useFakeTimers();
    try {
      const client = createFullMockClient();
      new AgentCache({
        client: client as any,
        configRefresh: { intervalMs: 100 },
      });
      await flushMicrotasks(5);
      const initialCalls = (client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length;

      vi.advanceTimersByTime(500);
      await flushMicrotasks(5);
      expect((client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialCalls);

      vi.advanceTimersByTime(500);
      await flushMicrotasks(5);
      expect((client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(initialCalls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer on shutdown()', async () => {
    vi.useFakeTimers();
    try {
      const client = createFullMockClient();
      const cache = new AgentCache({
        client: client as any,
        configRefresh: { intervalMs: 1000 },
      });
      await flushMicrotasks(5);
      await cache.shutdown();
      const callsAfterShutdown = (client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length;

      vi.advanceTimersByTime(60_000);
      await flushMicrotasks(5);
      expect((client.hgetall as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterShutdown);
    } finally {
      vi.useRealTimers();
    }
  });

  it('externally-written tool policy is visible after one refresh interval', async () => {
    vi.useFakeTimers();
    try {
      const client = createFullMockClient();
      (client.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});
      const cache = new AgentCache({
        client: client as any,
        configRefresh: { intervalMs: 1000 },
      });
      await flushMicrotasks(5);
      expect(cache.tool.getPolicy('search')).toBeUndefined();

      (client.hgetall as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        search: JSON.stringify({ ttl: 600 }),
      });
      vi.advanceTimersByTime(1000);
      await flushMicrotasks(5);

      expect(cache.tool.getPolicy('search')).toEqual({ ttl: 600 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('increments configRefreshFailed counter when hgetall throws', async () => {
    const registry = new Registry();
    const client = createFullMockClient();
    (client.hgetall as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('NOAUTH'));

    new AgentCache({
      client: client as any,
      telemetry: { registry },
    });
    await flushMicrotasks(5);

    const text = await registry.metrics();
    // Counter must be > 0; the exact value depends on how many ticks fired,
    // but the synchronous first tick is guaranteed.
    expect(text).toMatch(/agent_cache_config_refresh_failed_total\{cache_name="betterdb_ac"\} [1-9]/);
  });
});

describe('AgentCache cost table', () => {
  beforeEach(() => {
    createAnalyticsMock.mockResolvedValue({
      init: vi.fn().mockResolvedValue(undefined),
      capture: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    createAnalyticsMock.mockReset();
  });

  it('default cost table applies when no costTable provided', async () => {
    const client = createFullMockClient() as any;
    const cache = new AgentCache({ client });

    await cache.llm.store(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
      'response text',
      { tokens: { input: 1000, output: 1000 } },
    );

    const [, storedValue] = (client.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const entry = JSON.parse(storedValue);
    expect(entry.cost).toBeGreaterThan(0);
  });

  it('user costTable overrides default per-model', async () => {
    const client = createFullMockClient() as any;
    const cache = new AgentCache({
      client,
      costTable: { 'gpt-4o': { inputPer1k: 99, outputPer1k: 99 } },
    });

    await cache.llm.store(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
      'response text',
      { tokens: { input: 1000, output: 1000 } },
    );

    const [, storedValue] = (client.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const entry = JSON.parse(storedValue);
    // cost = (1000/1000)*99 + (1000/1000)*99 = 99 + 99 = 198
    expect(entry.cost).toBe(198);
  });

  it('user costTable does not remove other default entries', async () => {
    const client = createFullMockClient() as any;
    const cache = new AgentCache({
      client,
      costTable: { 'gpt-4o': { inputPer1k: 99, outputPer1k: 99 } },
    });

    // Verify gpt-4o-mini exists in the default table
    expect(DEFAULT_COST_TABLE['gpt-4o-mini']).toBeDefined();

    await cache.llm.store(
      { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] },
      'response text',
      { tokens: { input: 1000, output: 1000 } },
    );

    const [, storedValue] = (client.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const entry = JSON.parse(storedValue);
    expect(entry.cost).toBeGreaterThan(0);
  });

  it('useDefaultCostTable: false with no costTable disables cost tracking', async () => {
    const client = createFullMockClient() as any;
    const cache = new AgentCache({
      client,
      useDefaultCostTable: false,
    });

    await cache.llm.store(
      { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] },
      'response text',
      { tokens: { input: 1000, output: 1000 } },
    );

    const [, storedValue] = (client.set as ReturnType<typeof vi.fn>).mock.calls[0];
    const entry = JSON.parse(storedValue);
    expect(entry.cost).toBeUndefined();
  });
});
