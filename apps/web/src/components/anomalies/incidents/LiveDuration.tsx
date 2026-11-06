import type { IncidentTimeline } from '../../../types/anomaly';
import { formatDuration } from '../../../lib/formatters';
import { useNow } from '../../../hooks/useNow';
import { incidentDurationMs, isIncidentOpen } from './incident-summary';

interface LiveDurationProps {
  incident: IncidentTimeline;
  now?: number;
}

export function LiveDuration({ incident, now }: LiveDurationProps) {
  const open = isIncidentOpen(incident);
  const ticking = useNow(now === undefined && open);
  const duration = formatDuration(incidentDurationMs(incident, now ?? ticking));
  return <>{open ? `${duration} so far` : duration}</>;
}
