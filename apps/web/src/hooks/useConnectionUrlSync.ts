import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CONNECTION_PARAM } from './useConnection';

export function useConnectionUrlSync(connectionId: string | undefined): void {
  const [params, setParams] = useSearchParams();
  const inUrl = params.get(CONNECTION_PARAM);

  useEffect(() => {
    if (!connectionId || inUrl === connectionId) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(CONNECTION_PARAM, connectionId);
        return next;
      },
      { replace: true },
    );
  }, [connectionId, inUrl, setParams]);
}
