import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { useOversizeSessions, useSessionDetail, useSessionList } from '../useSessionExplorer';

const { api } = vi.hoisted(() => ({
  api: {
    listSessions: vi.fn(),
    oversize: vi.fn(),
    getSession: vi.fn(),
  },
}));

vi.mock('../../api/session-explorer', () => ({ sessionExplorerApi: api }));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: false } },
      })
    }
  >
    {children}
  </QueryClientProvider>
);

const refocus = () =>
  act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });

describe('session explorer queries', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.listSessions.mockResolvedValue({ sessions: [] });
    api.oversize.mockResolvedValue({ sessionIds: [] });
    api.getSession.mockResolvedValue({ sessionId: 's' });
  });

  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    await refocus();
  };

  it('does not rescan the keyspace in the background for the session list', async () => {
    renderHook(() => useSessionList('c1', 'ns'), { wrapper });
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.listSessions).toHaveBeenCalledTimes(1);
  });

  it('does not rescan the keyspace in the background for oversize sessions', async () => {
    renderHook(() => useOversizeSessions('c1', 'ns', true), { wrapper });
    await waitFor(() => expect(api.oversize).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.oversize).toHaveBeenCalledTimes(1);
  });

  it('does not reread a session when the window regains focus', async () => {
    renderHook(() => useSessionDetail('c1', 'ns', 's'), { wrapper });
    await waitFor(() => expect(api.getSession).toHaveBeenCalledTimes(1));
    await settle();
    expect(api.getSession).toHaveBeenCalledTimes(1);
  });
});
