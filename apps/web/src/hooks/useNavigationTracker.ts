import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

export function useNavigationTracker() {
  const location = useLocation();
  const previousPath = useRef<string | null>(null);

  useEffect(() => {
    if (previousPath.current !== null && previousPath.current !== location.pathname) {
      fetch('/api/telemetry/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventType: 'page_view',
          payload: { path: location.pathname },
        }),
      }).catch(() => {});
    }
    previousPath.current = location.pathname;
  }, [location.pathname]);
}
