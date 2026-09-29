import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('../api/client', () => ({ fetchApi: vi.fn() }));

import { fetchApi } from '../api/client';
import { useDiscoveredInstances } from './useDiscoveredInstances';

const instance = { host: 'cache', port: 6379, suggestedName: 'c', firstSeenAt: 0, lastSeenAt: 0, droppedPoints: 1 };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDiscoveredInstances', () => {
  beforeEach(() => vi.mocked(fetchApi).mockReset());

  it('returns instances when enabled server-side', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ enabled: true, instances: [instance] });
    const { result } = renderHook(() => useDiscoveredInstances(true), { wrapper });
    await waitFor(() => expect(result.current.instances).toEqual([instance]));
  });

  it('returns nothing when disabled server-side', async () => {
    vi.mocked(fetchApi).mockResolvedValue({ enabled: false, instances: [instance] });
    const { result } = renderHook(() => useDiscoveredInstances(true), { wrapper });
    await waitFor(() => expect(fetchApi).toHaveBeenCalled());
    expect(result.current.instances).toEqual([]);
  });

  it.each([
    [false, 1],
    [true, 2],
  ])('when the server reports enabled=%s it fetches %i time(s) across a poll interval', async (enabled, calls) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(fetchApi).mockResolvedValue({ enabled, instances: [] });
      renderHook(() => useDiscoveredInstances(true), { wrapper });
      await waitFor(() => expect(fetchApi).toHaveBeenCalledTimes(1));
      await act(() => vi.advanceTimersByTimeAsync(31_000));
      expect(fetchApi).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fetch when not allowed', () => {
    renderHook(() => useDiscoveredInstances(false), { wrapper });
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it('dismiss removes the row and posts host and port', async () => {
    vi.mocked(fetchApi).mockImplementation(async (url: string) =>
      url === '/connections/discovered' ? { enabled: true, instances: [instance] } : undefined,
    );
    const { result } = renderHook(() => useDiscoveredInstances(true), { wrapper });
    await waitFor(() => expect(result.current.instances).toHaveLength(1));
    vi.mocked(fetchApi).mockImplementation(async (url: string) =>
      url === '/connections/discovered' ? { enabled: true, instances: [] } : undefined,
    );
    await act(() => result.current.dismiss(instance));
    expect(fetchApi).toHaveBeenCalledWith('/connections/discovered/dismiss', {
      method: 'POST',
      body: JSON.stringify({ host: 'cache', port: 6379 }),
    });
    await waitFor(() => expect(result.current.instances).toEqual([]));
  });
});
