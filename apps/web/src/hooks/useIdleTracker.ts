import { useEffect, useRef } from 'react';
import { useTelemetry } from './useTelemetry';

const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const THROTTLE_MS = 30_000;

export function useIdleTracker(): void {
  const lastInteractionTime = useRef(Date.now());
  const lastThrottleUpdate = useRef(Date.now());
  const { client } = useTelemetry();

  useEffect(() => {
    const handler = (): void => {
      const now = Date.now();
      const idleDuration = now - lastInteractionTime.current;

      if (idleDuration >= IDLE_THRESHOLD_MS) {
        lastInteractionTime.current = now;
        lastThrottleUpdate.current = now;
        client.capture('interaction_after_idle', { idleDurationMs: idleDuration });
      } else if (now - lastThrottleUpdate.current >= THROTTLE_MS) {
        lastInteractionTime.current = now;
        lastThrottleUpdate.current = now;
      }
    };

    const events = ['mousemove', 'click', 'keydown', 'scroll', 'touchstart'] as const;
    for (const event of events) {
      document.addEventListener(event, handler, { passive: true });
    }

    return () => {
      for (const event of events) {
        document.removeEventListener(event, handler);
      }
    };
  }, [client]);
}
