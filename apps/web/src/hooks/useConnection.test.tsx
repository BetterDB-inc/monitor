import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectionState, type Connection } from './useConnection';

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
});
