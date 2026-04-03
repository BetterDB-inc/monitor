import { useEffect, useRef, useCallback, useState } from 'react';
import type { CliServerMessage } from '@betterdb/shared';

export type { CliServerMessage };

const WS_BASE = import.meta.env.PROD
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api`
  : 'ws://localhost:3001';

interface UseCliWebSocketOptions {
  connectionId: string | null;
  enabled: boolean;
  onMessage: (message: CliServerMessage) => void;
}

export function useCliWebSocket({ connectionId, enabled, onMessage }: UseCliWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reconnectDelayRef = useRef(1000);
  const onMessageRef = useRef(onMessage);
  const enabledRef = useRef(enabled);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const connectRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    connectRef.current = () => {
    if (
      wsRef.current?.readyState === WebSocket.OPEN ||
      wsRef.current?.readyState === WebSocket.CONNECTING
    )
      return;

    const ws = new WebSocket(`${WS_BASE}/cli/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      reconnectDelayRef.current = 1000;
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as CliServerMessage;
        onMessageRef.current(message);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      wsRef.current = null;
      if (enabledRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, 10000);
          connectRef.current?.();
        }, reconnectDelayRef.current);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror
    };
  };
  }); // Update connectRef on every render

  const connect = useCallback(() => {
    connectRef.current?.();
  }, []);

  useEffect(() => {
    if (enabled) {
      connect();
    }
    return () => {
      clearTimeout(reconnectTimeoutRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
        wsRef.current = null;
      }
      setIsConnected(false);
    };
  }, [enabled, connect]);

  // Reconnect when connectionId changes
  useEffect(() => {
    if (enabled && wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
      connect();
    }
  }, [connectionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(
    (command: string) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: 'execute',
            command,
            connectionId: connectionId || undefined,
          }),
        );
      }
    },
    [connectionId],
  );

  return { send, isConnected };
}
