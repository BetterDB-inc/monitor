import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalytics, NOOP_ANALYTICS, PostHogAnalytics, type ValkeyLike } from '../analytics';

function createMockValkeyClient(): ValkeyLike & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
  };
}

function createMockPostHog() {
  return {
    capture: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

describe('analytics', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BETTERDB_TELEMETRY;
    // Pin the per-install identity so distinctId is deterministic and the test
    // never reads/writes the real ~/.betterdb/instance_id.
    process.env.BETTERDB_INSTANCE_ID = 'install-123';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns noop when disabled option is true', async () => {
    const analytics = await createAnalytics({ disabled: true });
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  it('returns noop when no API key and baked placeholder is not replaced', async () => {
    const analytics = await createAnalytics();
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  it('returns noop when BETTERDB_TELEMETRY=false', async () => {
    process.env.BETTERDB_TELEMETRY = 'false';
    const analytics = await createAnalytics();
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  it('returns noop when BETTERDB_TELEMETRY=0', async () => {
    process.env.BETTERDB_TELEMETRY = '0';
    const analytics = await createAnalytics();
    expect(analytics).toBe(NOOP_ANALYTICS);
  });

  describe('NOOP_ANALYTICS', () => {
    it('init() never throws', async () => {
      const client = createMockValkeyClient();
      await expect(NOOP_ANALYTICS.init(client, 'test')).resolves.toBeUndefined();
    });

    it('capture() never throws', () => {
      expect(() => NOOP_ANALYTICS.capture('test_event')).not.toThrow();
    });

    it('shutdown() never throws', async () => {
      await expect(NOOP_ANALYTICS.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('PostHogAnalytics', () => {
    it('uses the per-install id as distinctId and persists a deployment id via Valkey SET', async () => {
      const ph = createMockPostHog();
      const analytics = new PostHogAnalytics(ph);

      const client = createMockValkeyClient();
      client.get.mockResolvedValue(null);

      await analytics.init(client, 'myprefix', { defaultTtl: 300 });

      // The Valkey-scoped deployment id is still generated and persisted.
      expect(client.get).toHaveBeenCalledWith('myprefix:__instance_id');
      expect(client.set).toHaveBeenCalledWith(
        'myprefix:__instance_id',
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      );

      // distinctId identifies the install; the deployment id rides along as a
      // property for roll-up.
      expect(ph.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'agent_cache:cache_init',
          distinctId: 'install-123',
          properties: expect.objectContaining({
            defaultTtl: 300,
            deployment_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          }),
        }),
      );
      // The start event is flushed immediately so it lands without an exit hook.
      expect(ph.flush).toHaveBeenCalled();

      await analytics.shutdown();
    });

    it('reuses an existing deployment id without a Valkey SET write', async () => {
      const ph = createMockPostHog();
      const analytics = new PostHogAnalytics(ph);

      const client = createMockValkeyClient();
      client.get.mockResolvedValue('stable-id');

      await analytics.init(client, 'myprefix');

      // Should NOT have called SET since the deployment id already exists.
      expect(client.set).not.toHaveBeenCalled();

      expect(ph.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: 'install-123',
          properties: expect.objectContaining({ deployment_id: 'stable-id' }),
        }),
      );

      await analytics.shutdown();
    });

    it('capture never throws even if posthog throws', async () => {
      const ph = createMockPostHog();
      ph.capture.mockImplementation(() => {
        throw new Error('PostHog error');
      });
      const analytics = new PostHogAnalytics(ph);

      const client = createMockValkeyClient();
      await analytics.init(client, 'test');

      // Should not throw
      expect(() => analytics.capture('some_event')).not.toThrow();

      await analytics.shutdown();
    });

    it('shutdown never throws even if posthog throws', async () => {
      const ph = createMockPostHog();
      ph.shutdown.mockRejectedValue(new Error('shutdown error'));
      const analytics = new PostHogAnalytics(ph);

      await expect(analytics.shutdown()).resolves.toBeUndefined();
    });
  });
});
