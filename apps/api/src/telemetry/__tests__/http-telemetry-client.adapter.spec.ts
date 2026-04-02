import { HttpTelemetryClientAdapter } from '../adapters/http-telemetry-client.adapter';

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

  it('should POST event with correct URL, method, headers, and body', () => {
    adapter.capture({
      distinctId: 'inst-123',
      event: 'app_start',
      properties: { version: '0.12.0', tier: 'community' },
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://betterdb.com/api/v1/telemetry',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toMatchObject({
      distinctId: 'inst-123',
      event: 'app_start',
      properties: { version: '0.12.0', tier: 'community' },
    });
  });

  it('should use a 5s timeout signal', () => {
    adapter.capture({ distinctId: 'inst-123', event: 'page_view' });

    const signal = fetchSpy.mock.calls[0][1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('should swallow fetch errors silently', () => {
    fetchSpy.mockRejectedValue(new Error('network failure'));

    expect(() =>
      adapter.capture({ distinctId: 'inst-123', event: 'app_start' }),
    ).not.toThrow();
  });

  it('should not call fetch on identify', () => {
    adapter.identify('inst-123', { tier: 'pro' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('should resolve shutdown without side effects', async () => {
    await expect(adapter.shutdown()).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
