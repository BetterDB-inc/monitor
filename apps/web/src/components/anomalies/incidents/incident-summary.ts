import { ApiError } from '../../../api/client';
import type { Connection } from '../../../hooks/useConnection';
import type { IncidentRecoveryStatus, IncidentTimeline } from '../../../types/anomaly';
import { metricLabel, patternLabel } from '../anomaly-display';

const OPEN_STATUSES: ReadonlySet<IncidentRecoveryStatus> = new Set([
  'active',
  'recovering',
  'degraded',
]);

export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function isIncidentOpen(incident: IncidentTimeline): boolean {
  return OPEN_STATUSES.has(incident.recovery.status);
}

export function incidentDurationMs(incident: IncidentTimeline, now: number): number {
  if (isIncidentOpen(incident)) return now - incident.startedAt;
  const end =
    incident.recovery.status === 'recovered'
      ? (incident.recovery.recoveredAt ?? incident.lastEventAt)
      : incident.lastEventAt;
  return end - incident.startedAt;
}

export function incidentTitle(incident: IncidentTimeline): string {
  if (incident.matchedPatterns.length > 0)
    return [...new Set(incident.matchedPatterns)].map(patternLabel).join(', ');
  const first = incident.entries[0];
  return first ? metricLabel(first.metricType) : 'Incident';
}

export function dateRangeQuery(
  start?: number | string | null,
  end?: number | string | null,
): string {
  if (start == null || end == null) return '';
  return new URLSearchParams({ start: String(start), end: String(end) }).toString();
}

export function incidentPath(incidentId: string, query = ''): string {
  const path = `/anomalies/incidents/${encodeURIComponent(incidentId)}`;
  return query ? `${path}?${query}` : path;
}

export type IncidentConnection = Pick<Connection, 'id' | 'capabilities' | 'membership'>;

export function incidentSubject(
  incident: IncidentTimeline,
  connections: IncidentConnection[],
): string {
  const involved = connections.filter((c) => incident.connectionIds.includes(c.id));
  if (involved.some((c) => c.capabilities?.clusterEnabled || c.membership?.source === 'cluster'))
    return 'the cluster';
  if (involved.some((c) => c.capabilities?.isSentinel || c.membership?.source === 'sentinel'))
    return 'the Sentinel deployment';
  return 'the instance';
}
