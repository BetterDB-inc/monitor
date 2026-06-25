import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalytics, NOOP_ANALYTICS, type AnalyticsClient } from '../analytics';

const phState = vi.hoisted(() => ({
  capture: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = phState.capture;
    shutdown = phState.shutdown;
  },
}));

function createMockClient(getResult: unknown = null): AnalyticsClient & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn().mockImplementation((command: string) => {
      if (command === 'GET') return Promise.resolve(getResult);
      if (command === 'SET') return Promise.resolve('OK');
      return Promise.resolve(null);
    }),
  };
}

describe('analytics', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BETTERDB_TELEMETRY;
    phState.capture.mockReset();
    phState.shutdown.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns noop when disabled option is true', async () => {
    const analytics = await createAnalytics({ apiKey: 'phc_test', disabled: true });
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  it('returns noop when no API key and baked placeholder is not replaced', async () => {
    const analytics = await createAnalytics();
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  it('returns noop when BETTERDB_TELEMETRY=false', async () => {
    process.env.BETTERDB_TELEMETRY = 'false';
    const analytics = await createAnalytics({ apiKey: 'phc_test' });
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  it('returns noop when BETTERDB_TELEMETRY=0', async () => {
    process.env.BETTERDB_TELEMETRY = '0';
    const analytics = await createAnalytics({ apiKey: 'phc_test' });
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  describe('NOOP_ANALYTICS', () => {
    it('init() never throws', async () => {
      const client = createMockClient();
      await expect(NOOP_ANALYTICS.init(client, 'test')).resolves.toBeUndefined();
    });

    it('capture() never throws', () => {
      expect(() => NOOP_ANALYTICS.capture('test_event')).not.toThrow();
    });

    it('shutdown() never throws', async () => {
      await expect(NOOP_ANALYTICS.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('PostHogAnalytics via createAnalytics', () => {
    it('init persists new UUID via SET when no existing ID', async () => {
      const analytics = await createAnalytics({ apiKey: 'phc_test_key' });
      expect(analytics).not.toBe(NOOP_ANALYTICS);

      const client = createMockClient(null);
      await analytics.init(client, 'myprefix', { hasEmbedFn: true });

      expect(client.call).toHaveBeenCalledWith('GET', 'myprefix:__instance_id');
      expect(client.call).toHaveBeenCalledWith(
        'SET',
        'myprefix:__instance_id',
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      );

      expect(phState.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent_memory:memory_init',
          properties: { hasEmbedFn: true },
        }),
      );
    });

    it('init reuses existing UUID from GET', async () => {
      const analytics = await createAnalytics({ apiKey: 'phc_test_key' });

      const existingId = 'existing-uuid-1234';
      const client = createMockClient(existingId);
      await analytics.init(client, 'myprefix');

      const setCalls = client.call.mock.calls.filter((c) => c[0] === 'SET');
      expect(setCalls).toHaveLength(0);
      expect(phState.capture).toHaveBeenCalledWith(
        expect.objectContaining({ distinctId: existingId }),
      );
    });

    it('capture never throws even if posthog throws', async () => {
      phState.capture.mockImplementation(() => {
        throw new Error('PostHog error');
      });

      const analytics = await createAnalytics({ apiKey: 'phc_test_key' });
      const client = createMockClient();
      await analytics.init(client, 'test');
      expect(() => analytics.capture('some_event')).not.toThrow();
    });

    it('shutdown never throws even if posthog throws', async () => {
      phState.shutdown.mockRejectedValue(new Error('shutdown error'));
      const analytics = await createAnalytics({ apiKey: 'phc_test_key' });
      await expect(analytics.shutdown()).resolves.toBeUndefined();
    });
  });
});
