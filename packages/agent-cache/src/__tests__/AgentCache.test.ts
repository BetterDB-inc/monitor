import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAnalyticsMock = vi.fn();

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

    const { AgentCache } = await import('../AgentCache');
    const cache = new AgentCache({
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
