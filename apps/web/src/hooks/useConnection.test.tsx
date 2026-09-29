import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTIONS_REFRESH_MS, useConnectionState, type Connection } from './useConnection';

const mocks = vi.hoisted(() => {
  return { fetchApi: vi.fn(), setCurrentConnectionId: vi.fn() };
});

vi.mock('../api/client', () => {
  return { fetchApi: mocks.fetchApi, setCurrentConnectionId: mocks.setCurrentConnectionId };
});

function connection(id: string): Connection {
  return { id, name: id, host: '127.0.0.1', port: 6379, isConnected: true };
}

function connectionsResponse(ids: string[]): { connections: Connection[]; currentId: null } {
  return { connections: ids.map(connection), currentId: null };
}

describe('useConnectionState', () => {
  beforeEach(() => {
    mocks.fetchApi.mockReset();
    mocks.fetchApi.mockResolvedValue(connectionsResponse([]));
    mocks.setCurrentConnectionId.mockReset();
  });

  it('moves off a connection that no longer exists instead of holding a dead selection', async () => {
    mocks.fetchApi.mockResolvedValueOnce(connectionsResponse(['conn-1', 'conn-2']));

    const { result } = renderHook(() => {
      return useConnectionState();
    });

    await waitFor(() => {
      expect(result.current.currentConnection?.id).toBe('conn-1');
    });

    mocks.fetchApi.mockResolvedValueOnce(connectionsResponse(['conn-2']));

    await act(async () => {
      await result.current.refreshConnections();
    });

    expect(result.current.currentConnection?.id).toBe('conn-2');
    expect(mocks.setCurrentConnectionId).toHaveBeenLastCalledWith('conn-2');
  });

  it('never falls back to a retired member when nothing is connected', async () => {
    const retired: Connection = {
      ...connection('retired'),
      isConnected: false,
      membership: { seedId: 'seed', nodeId: 'n1', origin: 'auto', source: 'cluster', retiredAt: 1 },
    };
    const idle: Connection = { ...connection('idle'), isConnected: false };
    mocks.fetchApi.mockResolvedValueOnce({ connections: [retired, idle], currentId: 'retired' });

    const { result } = renderHook(() => {
      return useConnectionState();
    });

    await waitFor(() => {
      expect(result.current.currentConnection?.id).toBe('idle');
    });
  });

  it('clears the selection when the last connection is removed', async () => {
    mocks.fetchApi.mockResolvedValueOnce(connectionsResponse(['conn-1']));

    const { result } = renderHook(() => {
      return useConnectionState();
    });

    await waitFor(() => {
      expect(result.current.currentConnection?.id).toBe('conn-1');
    });

    mocks.fetchApi.mockResolvedValueOnce(connectionsResponse([]));

    await act(async () => {
      await result.current.refreshConnections();
    });

    expect(result.current.currentConnection).toBeNull();
    expect(result.current.hasNoConnections).toBe(true);
  });

  it('keeps the selection when it is still listed', async () => {
    mocks.fetchApi.mockResolvedValueOnce(connectionsResponse(['conn-1', 'conn-2']));

    const { result } = renderHook(() => {
      return useConnectionState();
    });

    await waitFor(() => {
      expect(result.current.currentConnection?.id).toBe('conn-1');
    });

    act(() => {
      result.current.setConnection('conn-2');
    });

    mocks.fetchApi.mockResolvedValue(connectionsResponse(['conn-1', 'conn-2']));

    await act(async () => {
      await result.current.refreshConnections();
    });

    expect(result.current.currentConnection?.id).toBe('conn-2');
  });

  it('picks up children added by background topology reconciliation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.fetchApi.mockResolvedValue({
        connections: [{ ...connection('seed'), autoRegisterNodes: true }],
        currentId: null,
      });
      const { result } = renderHook(() => useConnectionState());
      await waitFor(() => expect(result.current.connections).toHaveLength(1));

      const child = { ...connection('child'), membership: { seedId: 'seed', nodeId: 'n', origin: 'auto' as const } };
      mocks.fetchApi.mockResolvedValue({
        connections: [{ ...connection('seed'), autoRegisterNodes: true }, child],
        currentId: null,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONNECTIONS_REFRESH_MS);
      });

      expect(result.current.connections.map((c) => c.id)).toEqual(['seed', 'child']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls for children when Sentinel auto-registration is on by default', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.fetchApi.mockResolvedValue({
        connections: [connection('sentinels')],
        currentId: null,
        autoRegisterNodesDefault: false,
        autoRegisterSentinelNodesDefault: true,
      });
      const { result } = renderHook(() => useConnectionState());
      await waitFor(() => expect(result.current.connections).toHaveLength(1));

      const child = { ...connection('child'), membership: { seedId: 'sentinels', nodeId: 'n', origin: 'auto' as const } };
      mocks.fetchApi.mockResolvedValue({
        connections: [connection('sentinels'), child],
        currentId: null,
        autoRegisterNodesDefault: false,
        autoRegisterSentinelNodesDefault: true,
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONNECTIONS_REFRESH_MS);
      });

      expect(result.current.connections.map((c) => c.id)).toEqual(['sentinels', 'child']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not poll when no connection follows cluster topology', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.fetchApi.mockResolvedValue(connectionsResponse(['conn-1']));
      const { result } = renderHook(() => useConnectionState());
      await waitFor(() => expect(result.current.connections).toHaveLength(1));
      const calls = mocks.fetchApi.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CONNECTIONS_REFRESH_MS * 2);
      });
      expect(mocks.fetchApi.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
