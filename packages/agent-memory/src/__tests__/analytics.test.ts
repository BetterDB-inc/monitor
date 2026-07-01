import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalytics, NOOP_ANALYTICS, type AnalyticsClient } from '../analytics';

const phState = vi.hoisted(() => ({
  capture: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = phState.capture;
    flush = phState.flush;
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
    // Pin the per-install identity so distinctId is deterministic and the test
    // never reads/writes the real ~/.betterdb/instance_id.
    process.env.BETTERDB_INSTANCE_ID = 'install-123';
    phState.capture.mockReset();
    phState.flush.mockReset().mockResolvedValue(undefined);
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
    it('uses the per-install id as distinctId and persists a deployment id via SET', async () => {
      const analytics = await createAnalytics({ apiKey: 'phc_test_key' });
      expect(analytics).not.toBe(NOOP_ANALYTICS);

      const client = createMockClient(null);
      await analytics.init(client, 'myprefix', { hasEmbedFn: true });

      // The Valkey-scoped deployment id is still generated and persisted.
      expect(client.call).toHaveBeenCalledWith('GET', 'myprefix:__instance_id');
      expect(client.call).toHaveBeenCalledWith(
        'SET',
        'myprefix:__instance_id',
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      );

      // distinctId identifies the install, not the Valkey store; the deployment
      // id rides along as a property for roll-up.
      expect(phState.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent_memory:memory_init',
          distinctId: 'install-123',
          properties: expect.objectContaining({
            hasEmbedFn: true,
            deployment_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          }),
        }),
      );
      // The start event is flushed immediately so it lands without an exit hook.
      expect(phState.flush).toHaveBeenCalled();
    });

    it('reuses an existing deployment id without a SET write', async () => {
      const analytics = await createAnalytics({ apiKey: 'phc_test_key' });

      const client = createMockClient('stable-id');
      await analytics.init(client, 'myprefix');

      const setCalls = client.call.mock.calls.filter((c) => c[0] === 'SET');
      expect(setCalls).toHaveLength(0);
      expect(phState.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: 'install-123',
          properties: expect.objectContaining({ deployment_id: 'stable-id' }),
        }),
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
