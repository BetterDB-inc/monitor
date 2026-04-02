import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoopTelemetryClient } from '../clients/noop-telemetry-client';
import { ApiTelemetryClient } from '../clients/api-telemetry-client';

vi.mock('../../api/client', () => ({
  fetchApi: vi.fn().mockResolvedValue({ ok: true }),
}));

import { fetchApi } from '../../api/client';

const mockFetchApi = vi.mocked(fetchApi);

describe('NoopTelemetryClient', () => {
  it('should implement capture without side effects', () => {
    const client = new NoopTelemetryClient();
    expect(() => client.capture('app_start')).not.toThrow();
  });

  it('should implement identify without side effects', () => {
    const client = new NoopTelemetryClient();
    expect(() => client.identify('id', {})).not.toThrow();
  });

  it('should implement shutdown without side effects', () => {
    const client = new NoopTelemetryClient();
    expect(() => client.shutdown()).not.toThrow();
  });
});

describe('ApiTelemetryClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should POST capture events to /telemetry/event', () => {
    const client = new ApiTelemetryClient();
    client.capture('page_view', { path: '/dashboard' });

    expect(mockFetchApi).toHaveBeenCalledWith('/telemetry/event', {
      method: 'POST',
      body: JSON.stringify({
        eventType: 'page_view',
        payload: { path: '/dashboard' },
      }),
    });
  });

  it('should not call fetchApi on identify', () => {
    const client = new ApiTelemetryClient();
    client.identify('inst-123', { tier: 'pro' });
    expect(mockFetchApi).not.toHaveBeenCalled();
  });

  it('should not call fetchApi on shutdown', () => {
    const client = new ApiTelemetryClient();
    client.shutdown();
    expect(mockFetchApi).not.toHaveBeenCalled();
  });
});
