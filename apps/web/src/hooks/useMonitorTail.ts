import { useEffect, useRef, useState, useCallback } from 'react';

export type TailStatus =
  | 'connecting'
  | 'streaming'
  | 'paused'
  | 'historical_complete'
  | 'session_ended'
  | 'closed'
  | 'error';

export interface MonitorTailHandle {
  /** Snapshot of buffered lines (oldest-first); flushed at most once per animation frame. */
  lines: string[];
  status: TailStatus;
  errorMessage: string | null;
  paused: boolean;
  /** Total lines received from the server since this hook mounted (NOT bounded by buffer). */
  totalReceived: number;
  /** True if the in-memory buffer hit its cap and the oldest lines were dropped. */
  bufferTrimmed: boolean;
  pause: () => void;
  resume: () => void;
}

interface OutboundLine {
  type: 'line';
  line: string;
}
interface OutboundStatus {
  type: 'status';
  status: string;
}
interface OutboundError {
  type: 'error';
  error: string;
}
type Outbound = OutboundLine | OutboundStatus | OutboundError;

/**
 * In production the API is same-origin under `/api`; in dev vite hits the API
 * on port 3001. The TailGateway is mounted under both `/monitor/ws` and
 * `/api/monitor/ws` so either form works (see apps/api/src/main.ts).
 */
function buildWsUrl(sessionId: string): string {
  const base = import.meta.env.PROD
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/monitor/ws`
    : `ws://localhost:3001/monitor/ws`;
  return `${base}?sessionId=${encodeURIComponent(sessionId)}`;
}

/**
 * Subscribe to a capture session's MONITOR tail.
 *
 * Lines accumulate in a mutable ref-buffer to avoid one re-render per ingested
 * line. We snapshot the buffer into state at most once per animation frame so
 * the UI batches updates at ~60 Hz even at thousands of lines/sec. The buffer
 * is bounded — when it reaches `bufferSize`, the oldest lines are dropped and
 * `bufferTrimmed` flips true.
 *
 * Pause / resume are server-side: pause sends `{type:'pause'}` over the socket
 * and the gateway buffers lines in its own per-viewer queue; resume drains
 * them in original order.
 */
export function useMonitorTail(
  sessionId: string | null,
  bufferSize = 5000,
): MonitorTailHandle {
  const linesBufferRef = useRef<string[]>([]);
  const totalReceivedRef = useRef(0);
  const trimmedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const rafScheduledRef = useRef(false);

  const [lines, setLines] = useState<string[]>([]);
  const [totalReceived, setTotalReceived] = useState(0);
  const [bufferTrimmed, setBufferTrimmed] = useState(false);
  const [status, setStatus] = useState<TailStatus>('connecting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const flush = useCallback(() => {
    if (rafScheduledRef.current) return;
    rafScheduledRef.current = true;
    requestAnimationFrame(() => {
      rafScheduledRef.current = false;
      setLines([...linesBufferRef.current]);
      setTotalReceived(totalReceivedRef.current);
      setBufferTrimmed(trimmedRef.current);
    });
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    // Reset state for a fresh session. React 18 batches these into a single
    // commit since they all run synchronously before any async work (WS open
    // happens later via the event loop).
    linesBufferRef.current = [];
    totalReceivedRef.current = 0;
    trimmedRef.current = false;
    /* eslint-disable react-hooks/set-state-in-effect */
    setLines([]);
    setTotalReceived(0);
    setBufferTrimmed(false);
    setStatus('connecting');
    setErrorMessage(null);
    setPaused(false);
    /* eslint-enable react-hooks/set-state-in-effect */

    const ws = new WebSocket(buildWsUrl(sessionId));
    wsRef.current = ws;

    ws.onopen = () => setStatus('streaming');
    ws.onerror = () => {
      setErrorMessage('WebSocket connection error');
      setStatus('error');
    };
    ws.onclose = () => {
      setStatus((current) =>
        current === 'historical_complete' || current === 'session_ended' || current === 'error'
          ? current
          : 'closed',
      );
    };
    ws.onmessage = (event) => {
      let msg: Outbound;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (msg.type === 'line') {
        totalReceivedRef.current += 1;
        linesBufferRef.current.push(msg.line);
        if (linesBufferRef.current.length > bufferSize) {
          linesBufferRef.current = linesBufferRef.current.slice(-bufferSize);
          trimmedRef.current = true;
        }
        flush();
      } else if (msg.type === 'status') {
        if (msg.status === 'historical_complete') setStatus('historical_complete');
        else if (msg.status === 'session_ended') setStatus('session_ended');
      } else if (msg.type === 'error') {
        setErrorMessage(msg.error);
        setStatus('error');
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, bufferSize, flush]);

  const pause = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'pause' }));
    setPaused(true);
    setStatus('paused');
  }, []);

  const resume = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'resume' }));
    setPaused(false);
    setStatus('streaming');
  }, []);

  return {
    lines,
    status,
    errorMessage,
    paused,
    totalReceived,
    bufferTrimmed,
    pause,
    resume,
  };
}
