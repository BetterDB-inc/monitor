import { createContext, useContext, type ReactNode } from 'react';
import type { IncidentTimeline } from '../../../types/anomaly';
import { formatDuration } from '../../../lib/formatters';
import { useNow } from '../../../hooks/useNow';
import { incidentDurationMs, isIncidentOpen } from './incident-summary';

const SharedClock = createContext<number | undefined>(undefined);

interface LiveClockProps {
  enabled: boolean;
  children: ReactNode;
}

export function LiveClock({ enabled, children }: LiveClockProps) {
  const now = useNow(enabled);
  return <SharedClock.Provider value={enabled ? now : undefined}>{children}</SharedClock.Provider>;
}

interface LiveDurationProps {
  incident: IncidentTimeline;
  now?: number;
}

export function LiveDuration({ incident, now }: LiveDurationProps) {
  const open = isIncidentOpen(incident);
  const shared = useContext(SharedClock);
  const own = useNow(now === undefined && shared === undefined && open);
  const duration = formatDuration(incidentDurationMs(incident, now ?? shared ?? own));
  return <>{open ? `${duration} so far` : duration}</>;
}
