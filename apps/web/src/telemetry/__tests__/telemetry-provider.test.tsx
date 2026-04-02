import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TelemetryConfigProvider } from '../TelemetryConfigProvider';
import { useTelemetry } from '../../hooks/useTelemetry';
import { ApiTelemetryClient } from '../clients/api-telemetry-client';
import { NoopTelemetryClient } from '../clients/noop-telemetry-client';

vi.mock('../../api/client', () => ({
  fetchApi: vi.fn(),
}));

import { fetchApi } from '../../api/client';

const mockFetchApi = vi.mocked(fetchApi);

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <TelemetryConfigProvider>{children}</TelemetryConfigProvider>;
  };
}

describe('TelemetryConfigProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should provide ApiTelemetryClient when provider is "http"', async () => {
    mockFetchApi.mockResolvedValue({
      instanceId: 'inst-123',
      telemetryEnabled: true,
      provider: 'http',
    });

    const { result } = renderHook(() => useTelemetry(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current).toBeInstanceOf(ApiTelemetryClient);
    });
  });

  it('should provide NoopTelemetryClient when telemetryEnabled is false', async () => {
    mockFetchApi.mockResolvedValue({
      instanceId: 'inst-123',
      telemetryEnabled: false,
      provider: 'posthog',
    });

    const { result } = renderHook(() => useTelemetry(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current).toBeInstanceOf(NoopTelemetryClient);
    });
  });

  it('should fall back to ApiTelemetryClient when config fetch fails', async () => {
    mockFetchApi.mockRejectedValue(new Error('network error'));

    const { result } = renderHook(() => useTelemetry(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current).toBeInstanceOf(ApiTelemetryClient);
    });
  });

  it('should provide NoopTelemetryClient when provider is "noop"', async () => {
    mockFetchApi.mockResolvedValue({
      instanceId: 'inst-123',
      telemetryEnabled: true,
      provider: 'noop',
    });

    const { result } = renderHook(() => useTelemetry(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current).toBeInstanceOf(NoopTelemetryClient);
    });
  });
});
