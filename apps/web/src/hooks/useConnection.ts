import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { setCurrentConnectionId, fetchApi } from '../api/client';

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  isConnected: boolean;
}

export interface ConnectionContextValue {
  /** Current selected connection */
  currentConnection: Connection | null;
  /** All available connections */
  connections: Connection[];
  /** Whether connections are loading */
  loading: boolean;
  /** Error message if failed to load connections */
  error: string | null;
  /** Switch to a different connection */
  setConnection: (connectionId: string) => void;
  /** Refresh connections list */
  refreshConnections: () => Promise<void>;
}

export const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function useConnection(): ConnectionContextValue {
  const context = useContext(ConnectionContext);
  if (!context) {
    throw new Error('useConnection must be used within a ConnectionProvider');
  }
  return context;
}

/**
 * Hook to create connection context state.
 * Use this in App.tsx to create the provider value.
 */
export function useConnectionState(): ConnectionContextValue {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [currentConnection, setCurrentConnection] = useState<Connection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConnections = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch connections from API using centralized client
      const responseData = await fetchApi<{ connections: Connection[]; currentId: string | null }>('/connections');
      const data: Connection[] = responseData.connections || [];
      setConnections(data);

      // If no current connection is set, select the first connected one or use currentId from response
      if (!currentConnection && data.length > 0) {
        const defaultConnection =
          (responseData.currentId && data.find(c => c.id === responseData.currentId)) ||
          data.find(c => c.isConnected) ||
          data[0];
        setCurrentConnection(defaultConnection);
        setCurrentConnectionId(defaultConnection.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch connections');
      console.error('Failed to fetch connections:', err);
    } finally {
      setLoading(false);
    }
  }, [currentConnection]);

  const setConnection = useCallback((connectionId: string) => {
    const connection = connections.find(c => c.id === connectionId);
    if (connection) {
      setCurrentConnection(connection);
      setCurrentConnectionId(connection.id);
    }
  }, [connections]);

  // Sync currentConnectionId with API client whenever currentConnection changes
  useEffect(() => {
    setCurrentConnectionId(currentConnection?.id ?? null);
  }, [currentConnection?.id]);

  // Fetch connections on mount
  useEffect(() => {
    fetchConnections();
  }, []);

  return {
    currentConnection,
    connections,
    loading,
    error,
    setConnection,
    refreshConnections: fetchConnections,
  };
}
