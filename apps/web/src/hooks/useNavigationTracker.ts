import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchApi } from '../api/client';

export function useNavigationTracker() {
  const location = useLocation();
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    if (previousPath.current !== null && previousPath.current !== location.pathname) {
      fetchApi('/telemetry/event', {
        method: 'POST',
        body: JSON.stringify({
          eventType: 'page_view',
          payload: { path: location.pathname },
        }),
      }).catch(() => {});
    }
    previousPath.current = location.pathname;
  }, [location.pathname]);
}
