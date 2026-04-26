import { HttpTelemetryClientAdapter } from '../adapters/http-telemetry-client.adapter';

const TEST_VERSION = '1.0.0-test';

describe('HttpTelemetryClientAdapter', () => {
  let adapter: HttpTelemetryClientAdapter;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    adapter = new HttpTelemetryClientAdapter('https://betterdb.com/api/v1/telemetry');
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('should POST event remapped to the legacy HTTP format', () => {
    adapter.capture({
      distinctId: 'inst-123',
      event: 'app_start',
      properties: {
        version: TEST_VERSION,
        tier: 'community',
        deploymentMode: 'self-hosted',
        timestamp: 1000,
      },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://betterdb.com/api/v1/telemetry',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({
      instanceId: 'inst-123',
      eventType: 'app_start',
      version: TEST_VERSION,
      tier: 'community',
      deploymentMode: 'self-hosted',
      timestamp: 1000,
    });
  });

  it('should include extra properties as payload', () => {
    adapter.capture({
      distinctId: 'inst-123',
      event: 'db_connect',
      properties: {
        version: TEST_VERSION,
        tier: 'community',
        deploymentMode: 'self-hosted',
        timestamp: 1000,
        connectionType: 'standalone',
        success: true,
      },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.payload).toEqual({
      connectionType: 'standalone',
      success: true,
    });
  });

  it('should use a 5s timeout signal', () => {
    adapter.capture({ distinctId: 'inst-123', event: 'page_view' });

    const signal = fetchSpy.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('should swallow fetch errors silently', async () => {
    fetchSpy.mockRejectedValue(new Error('network failure'));

    adapter.capture({ distinctId: 'inst-123', event: 'app_start' });

    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('should not call fetch on identify', () => {
    adapter.identify('inst-123', { tier: 'pro' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should abort in-flight requests on shutdown', async () => {
    fetchSpy.mockReturnValue(new Promise(() => {}));

    adapter.capture({ distinctId: 'inst-123', event: 'app_start' });

    const signal = fetchSpy.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    await adapter.shutdown();

    expect(signal.aborted).toBe(true);
  });

  it('should resolve shutdown without side effects when no requests pending', async () => {
    await expect(adapter.shutdown()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
