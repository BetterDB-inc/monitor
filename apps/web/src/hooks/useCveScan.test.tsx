import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scanResult } from '../pages/__fixtures__/cve';
import { useCveScan, useRefreshCveScan } from './useCveScan';

const mocks = vi.hoisted(() => {
  return { scan: vi.fn(), dataset: vi.fn(), refresh: vi.fn() };
});

const connection = vi.hoisted(() => {
  return { id: null as string | null };
});

vi.mock('../api/cve', () => {
  return {
    fetchCveScan: mocks.scan,
    fetchCveDataset: mocks.dataset,
    refreshCveScan: mocks.refresh,
  };
});

vi.mock('./useConnection', () => {
  return {
    useConnection: () => {
      return {
        currentConnection:
          connection.id === null
            ? null
            : { id: connection.id, name: connection.id, host: 'h', port: 6379, isConnected: true },
        connections: [],
        loading: false,
        error: null,
        setConnection: vi.fn(),
        refreshConnections: vi.fn(),
        hasNoConnections: false,
      };
    },
  };
});

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useCveScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connection.id = 'conn-a';
  });

  it('does not fire a scan request before a connection is selected', () => {
    connection.id = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(
      () => {
        return useCveScan();
      },
      { wrapper: wrapperFor(client) },
    );

    expect(mocks.scan).not.toHaveBeenCalled();
  });

  it('scans under the selected connection key', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.scan.mockResolvedValue(scanResult({ connectionId: 'conn-a' }));

    const { result } = renderHook(
      () => {
        return useCveScan();
      },
      { wrapper: wrapperFor(client) },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(client.getQueryData(['cve', 'scan', 'conn-a'])).toBeDefined();
  });
});

describe('useRefreshCveScan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connection.id = 'conn-b';
  });

  it('files a rescan under the connection the payload names, not the one now selected', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const payload = scanResult({ connectionId: 'conn-a' });
    mocks.refresh.mockResolvedValue(payload);

    const { result } = renderHook(
      () => {
        return useRefreshCveScan();
      },
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(client.getQueryData(['cve', 'scan', 'conn-a'])).toEqual(payload);
    expect(client.getQueryData(['cve', 'scan', 'conn-b'])).toBeUndefined();
  });

  it('reports a failed rescan rather than settling silently', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.refresh.mockRejectedValue(new Error('connection refused'));

    const { result } = renderHook(
      () => {
        return useRefreshCveScan();
      },
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate();

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error?.message).toBe('connection refused');
  });
});
