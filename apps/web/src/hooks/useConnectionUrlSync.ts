import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CONNECTION_PARAM } from '../lib/connectionParam';
import type { Connection } from './useConnection';

interface ConnectionUrlSyncOptions {
  connectionId: string | undefined;
  connections: Connection[];
  loading: boolean;
  error: string | null;
  setConnection: (connectionId: string) => void;
}

export function useConnectionUrlSync({
  connectionId,
  connections,
  loading,
  error,
  setConnection,
}: ConnectionUrlSyncOptions): void {
  const location = useLocation();
  const navigate = useNavigate();
  const inUrl = new URLSearchParams(location.search).get(CONNECTION_PARAM);
  const lastInUrl = useRef(inUrl);

  useEffect(() => {
    const urlMoved = inUrl !== lastInUrl.current;
    lastInUrl.current = inUrl;
    if (loading) return;
    if (
      urlMoved &&
      inUrl !== null &&
      inUrl !== connectionId &&
      connections.some((c) => c.id === inUrl)
    ) {
      setConnection(inUrl);
      return;
    }
    const wanted = connectionId ?? null;
    if (inUrl === wanted) return;
    if (wanted === null && error !== null) return;
    const params = new URLSearchParams(location.search);
    if (wanted === null) {
      params.delete(CONNECTION_PARAM);
    } else {
      params.set(CONNECTION_PARAM, wanted);
    }
    const search = params.toString();
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [
    inUrl,
    connectionId,
    connections,
    loading,
    error,
    setConnection,
    navigate,
    location.pathname,
    location.search,
    location.hash,
    location.state,
  ]);
}
