import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useTelemetry } from './useTelemetry';

export function useNavigationTracker(): void {
  const location = useLocation();
  const previousPath = useRef<string | null>(null);
  const { client } = useTelemetry();

  useEffect(() => {
    if (previousPath.current !== null && previousPath.current !== location.pathname) {
      client.capture('page_view', { path: location.pathname });
    }
    previousPath.current = location.pathname;
  }, [location.pathname, client]);
}
