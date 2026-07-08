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

    it('awaits the init flush so a process exiting right after init still delivers', async () => {
      const ph = createMockPostHog();
      let flushed = false;
      ph.flush.mockImplementation(async () => {
        await Promise.resolve();
        flushed = true;
      });
      const analytics = new PostHogAnalytics(ph);
      const client = createMockValkeyClient();

      await analytics.init(client, 'p');

      // No serverless waitUntil here: init must await the flush inline so the
      // start event lands even if the caller exits (e.g. process.exit) right after.
      expect(flushed).toBe(true);

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

  describe('serverless delivery (waitUntil)', () => {
    const VERCEL_CTX = Symbol.for('@vercel/request-context');
    let pending: Promise<unknown>[];
    let waitUntil: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      pending = [];
      waitUntil = vi.fn((p: Promise<unknown>) => {
        pending.push(p);
      });
      (globalThis as Record<symbol, unknown>)[VERCEL_CTX] = { get: () => ({ waitUntil }) };
    });

    afterEach(() => {
      delete (globalThis as Record<symbol, unknown>)[VERCEL_CTX];
      vi.useRealTimers();
    });

    it('hands the init flush to the request waitUntil so the invocation stays alive', async () => {
      const ph = createMockPostHog();
      const analytics = new PostHogAnalytics(ph);
      const client = createMockValkeyClient();

      await analytics.init(client, 'p');

      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
      await Promise.all(pending);
      expect(ph.flush).toHaveBeenCalled();

      await analytics.shutdown();
    });

    it('emits a registered snapshot from onActivity once the interval elapses', async () => {
      vi.useFakeTimers();
      const ph = createMockPostHog();
      const analytics = new PostHogAnalytics(ph);
      const client = createMockValkeyClient();
      await analytics.init(client, 'p');
      await Promise.all(pending);
      pending = [];
      waitUntil.mockClear();

      const snapshot = vi.fn().mockResolvedValue(undefined);
      analytics.registerSnapshot(1000, snapshot);

      // Interval not elapsed yet — no snapshot emitted.
      analytics.onActivity();
      expect(snapshot).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1001);
      analytics.onActivity();
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(pending);
      expect(snapshot).toHaveBeenCalledTimes(1);

      await analytics.shutdown();
    });

    it('shares one throttle clock between snapshotTick and onActivity (no double-emit)', () => {
      vi.useFakeTimers();
      const ph = createMockPostHog();
      const analytics = new PostHogAnalytics(ph);
      const snapshot = vi.fn().mockResolvedValue(undefined);
      analytics.registerSnapshot(1000, snapshot);

      vi.advanceTimersByTime(1001);
      // The interval timer fires first and emits inline for this interval...
      analytics.snapshotTick();
      // ...so a request in the same warm invocation must not re-emit: onActivity
      // sees the shared lastSnapshotAt and skips before reaching waitUntil.
      analytics.onActivity();

      expect(snapshot).toHaveBeenCalledTimes(1);
      expect(waitUntil).not.toHaveBeenCalled();
    });

    it('onActivity is a no-op with no request context (long-lived server path)', () => {
      delete (globalThis as Record<symbol, unknown>)[VERCEL_CTX];
      const ph = createMockPostHog();
      const analytics = new PostHogAnalytics(ph);
      const snapshot = vi.fn().mockResolvedValue(undefined);
      analytics.registerSnapshot(1, snapshot);
      analytics.onActivity();
      expect(snapshot).not.toHaveBeenCalled();
    });
  });
});
