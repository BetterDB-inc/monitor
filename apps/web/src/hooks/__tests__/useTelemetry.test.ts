import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('../../api/client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../../api/client';

const mockFetchApi = vi.mocked(fetchApi);

describe('useTelemetry', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  async function importHook(): Promise<typeof import('../useTelemetry')> {
    return vi.importActual('../useTelemetry') as Promise<typeof import('../useTelemetry')>;
  }

  it('should resolve to ApiTelemetryClient for http provider', async () => {
    mockFetchApi.mockResolvedValue({
      instanceId: 'inst-123',
      telemetryEnabled: true,
      provider: 'http',
    });

    const { useTelemetry } = await importHook();
    const { result } = renderHook(() => useTelemetry());

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

    const { useTelemetry } = await importHook();
    const { result } = renderHook(() => useTelemetry());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.client.constructor.name).toBe('NoopTelemetryClient');
  });

  it('should fall back to ApiTelemetryClient when config fetch fails', async () => {
    mockFetchApi.mockRejectedValue(new Error('network error'));

    const { useTelemetry } = await importHook();
    const { result } = renderHook(() => useTelemetry());

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

    const { useTelemetry } = await importHook();
    const { result } = renderHook(() => useTelemetry());

    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });

    expect(result.current.client.constructor.name).toBe('NoopTelemetryClient');
  });
});
