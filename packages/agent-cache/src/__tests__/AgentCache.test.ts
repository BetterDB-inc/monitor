import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
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
