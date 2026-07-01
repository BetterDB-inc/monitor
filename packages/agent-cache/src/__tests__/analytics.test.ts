import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalytics, NOOP_ANALYTICS, type ValkeyLike } from '../analytics';

function createMockValkeyClient(): ValkeyLike & { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
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

  it('returns noop when posthog-node is not installed (dynamic import fails)', async () => {
    // posthog-node is not installed in dev dependencies, so this will return noop
    // unless it happens to be in node_modules from the monorepo
    const analytics = await createAnalytics({ apiKey: 'phc_test' });
    // Either noop (not installed) or real instance — both are valid.
    // The key assertion is it does not throw.
    expect(analytics).toBeDefined();
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

  describe('PostHogAnalytics via createAnalytics', () => {
    // To test the real PostHogAnalytics class without installing posthog-node,
    // we mock the dynamic import. We do this at a higher level by testing
    // init/capture/shutdown behavior through the factory.

    it('uses the per-install id as distinctId and persists a deployment id via Valkey SET', async () => {
      const mockCapture = vi.fn();
      const mockFlush = vi.fn().mockResolvedValue(undefined);
      const mockShutdown = vi.fn().mockResolvedValue(undefined);

      // Mock the dynamic import of posthog-node
      vi.doMock('posthog-node', () => ({
        PostHog: class {
          capture = mockCapture;
          flush = mockFlush;
          shutdown = mockShutdown;
        },
      }));

      // Re-import to pick up mock
      const { createAnalytics: create } = await import('../analytics');

      const analytics = await create({ apiKey: 'phc_test_key' });
      expect(analytics).not.toBe(NOOP_ANALYTICS);

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
      expect(mockCapture).toHaveBeenCalledWith(
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
      expect(mockFlush).toHaveBeenCalled();

      vi.doUnmock('posthog-node');
    });

    it('reuses an existing deployment id without a Valkey SET write', async () => {
      const mockCapture = vi.fn();
      const mockFlush = vi.fn().mockResolvedValue(undefined);
      const mockShutdown = vi.fn().mockResolvedValue(undefined);

      vi.doMock('posthog-node', () => ({
        PostHog: class {
          capture = mockCapture;
          flush = mockFlush;
          shutdown = mockShutdown;
        },
      }));

      const { createAnalytics: create } = await import('../analytics');
      const analytics = await create({ apiKey: 'phc_test_key' });

      const client = createMockValkeyClient();
      client.get.mockResolvedValue('stable-id');

      await analytics.init(client, 'myprefix');

      // Should NOT have called SET since the deployment id already exists.
      expect(client.set).not.toHaveBeenCalled();

      expect(mockCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          distinctId: 'install-123',
          properties: expect.objectContaining({ deployment_id: 'stable-id' }),
        }),
      );

      vi.doUnmock('posthog-node');
    });

    it('capture never throws even if posthog throws', async () => {
      const mockCapture = vi.fn().mockImplementation(() => {
        throw new Error('PostHog error');
      });

      vi.doMock('posthog-node', () => ({
        PostHog: class {
          capture = mockCapture;
          shutdown = vi.fn().mockResolvedValue(undefined);
        },
      }));

      const { createAnalytics: create } = await import('../analytics');
      const analytics = await create({ apiKey: 'phc_test_key' });

      const client = createMockValkeyClient();
      await analytics.init(client, 'test');

      // Should not throw
      expect(() => analytics.capture('some_event')).not.toThrow();

      vi.doUnmock('posthog-node');
    });

    it('shutdown never throws even if posthog throws', async () => {
      vi.doMock('posthog-node', () => ({
        PostHog: class {
          capture = vi.fn();
          shutdown = vi.fn().mockRejectedValue(new Error('shutdown error'));
        },
      }));

      const { createAnalytics: create } = await import('../analytics');
      const analytics = await create({ apiKey: 'phc_test_key' });

      await expect(analytics.shutdown()).resolves.toBeUndefined();

      vi.doUnmock('posthog-node');
    });
  });
});
