import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderHookWithQuery } from '../../test/test-utils';

vi.mock('../../api/client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../../api/client';
import { useTelemetry } from '../useTelemetry';

const mockFetchApi = vi.mocked(fetchApi);

describe('useTelemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should resolve to ApiTelemetryClient for http provider', async () => {
    mockFetchApi.mockResolvedValue({
      instanceId: 'inst-123',
      telemetryEnabled: true,
      provider: 'http',
    });

    const { result } = renderHookWithQuery(() => useTelemetry());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.client.constructor.name).toBe('ApiTelemetryClient');
  });

  it('should return NoopTelemetryClient when telemetryEnabled is false', async () => {
    mockFetchApi.mockResolvedValue({
      instanceId: 'inst-123',
      telemetryEnabled: false,
      provider: 'posthog',
    });

    const { result } = renderHookWithQuery(() => useTelemetry());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.client.constructor.name).toBe('NoopTelemetryClient');
  });

  it('should fall back to ApiTelemetryClient when config fetch fails', async () => {
    mockFetchApi.mockRejectedValue(new Error('network error'));

    const { result } = renderHookWithQuery(() => useTelemetry());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.client.constructor.name).toBe('ApiTelemetryClient');
  });

  it('should return NoopTelemetryClient for noop provider', async () => {
    mockFetchApi.mockResolvedValue({
      instanceId: 'inst-123',
      telemetryEnabled: true,
      provider: 'noop',
    });

    const { result } = renderHookWithQuery(() => useTelemetry());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.client.constructor.name).toBe('NoopTelemetryClient');
  });
});
