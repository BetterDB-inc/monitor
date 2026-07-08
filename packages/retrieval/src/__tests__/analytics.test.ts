import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAnalytics, NOOP_ANALYTICS, PostHogAnalytics, type AnalyticsClient } from '../analytics';

const phState = {
  capture: vi.fn(),
  flush: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

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

  describe('PostHogAnalytics', () => {
    it('uses the per-install id as distinctId and persists a deployment id via SET', async () => {
      const analytics = new PostHogAnalytics(phState);

      const client = createMockClient(null);
      await analytics.init(client, 'myprefix', { fieldCount: 3 });

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
          event: 'retrieval:retriever_init',
          distinctId: 'install-123',
          properties: expect.objectContaining({
            fieldCount: 3,
            deployment_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          }),
        }),
      );
      // The start event is flushed immediately so it lands without an exit hook.
      expect(phState.flush).toHaveBeenCalled();
    });

    it('awaits the init flush so a process exiting right after init still delivers', async () => {
      let flushed = false;
      phState.flush.mockImplementation(async () => {
        await Promise.resolve();
        flushed = true;
      });
      const analytics = new PostHogAnalytics(phState);
      const client = createMockClient();

      await analytics.init(client, 'p');

      // No serverless waitUntil here: init must await the flush inline so the
      // start event lands even if the caller exits (e.g. process.exit) right after.
      expect(flushed).toBe(true);
    });

    it('reuses an existing deployment id without a SET write', async () => {
      const analytics = new PostHogAnalytics(phState);

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

      const analytics = new PostHogAnalytics(phState);
      const client = createMockClient();
      await analytics.init(client, 'test');
      expect(() => analytics.capture('some_event')).not.toThrow();
    });

    it('shutdown never throws even if posthog throws', async () => {
      phState.shutdown.mockRejectedValue(new Error('shutdown error'));
      const analytics = new PostHogAnalytics(phState);
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
      const analytics = new PostHogAnalytics(phState);
      const client = createMockClient();

      await analytics.init(client, 'p');

      expect(waitUntil).toHaveBeenCalledTimes(1);
      expect(waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
      await Promise.all(pending);
      expect(phState.flush).toHaveBeenCalled();
    });

    it('emits a registered snapshot from onActivity once the interval elapses', async () => {
      vi.useFakeTimers();
      const analytics = new PostHogAnalytics(phState);
      const client = createMockClient();
      await analytics.init(client, 'p');
      await Promise.all(pending);
      pending = [];
      waitUntil.mockClear();

      const snapshot = vi.fn().mockResolvedValue(undefined);
      analytics.registerSnapshot(1000, snapshot);

      analytics.onActivity();
      expect(snapshot).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1001);
      analytics.onActivity();
      expect(waitUntil).toHaveBeenCalledTimes(1);
      await Promise.all(pending);
      expect(snapshot).toHaveBeenCalledTimes(1);
    });

    it('onActivity is a no-op with no request context (long-lived server path)', () => {
      delete (globalThis as Record<symbol, unknown>)[VERCEL_CTX];
      const analytics = new PostHogAnalytics(phState);
      const snapshot = vi.fn().mockResolvedValue(undefined);
      analytics.registerSnapshot(1, snapshot);
      analytics.onActivity();
      expect(snapshot).not.toHaveBeenCalled();
    });
  });
});
