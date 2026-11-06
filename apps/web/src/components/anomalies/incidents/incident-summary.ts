import { ApiError } from '../../../api/client';
import type { IncidentRecoveryStatus, IncidentTimeline } from '../../../types/anomaly';
import { metricLabel, patternLabel } from '../anomaly-display';
import type { DateRange } from '../../ui/date-range-picker';

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

function settledRecoveryAt(incident: IncidentTimeline): number | null {
  return incident.recovery.status === 'recovered' ? incident.recovery.recoveredAt : null;
}

export function isDurationOngoing(incident: IncidentTimeline): boolean {
  return settledRecoveryAt(incident) === null && isIncidentOpen(incident);
}

export function incidentDurationMs(incident: IncidentTimeline, now: number): number {
  const recoveredAt = settledRecoveryAt(incident);
  if (recoveredAt !== null) return recoveredAt - incident.startedAt;
  return (isIncidentOpen(incident) ? now : incident.lastEventAt) - incident.startedAt;
}

export function incidentTitle(incident: IncidentTimeline): string {
  if (incident.matchedPatterns.length > 0)
    return [...new Set(incident.matchedPatterns)].map(patternLabel).join(', ');
  const first = orderedEntries(incident)[0];
  return first ? metricLabel(first.metricType) : 'Incident';
}

export function orderedEntries(incident: IncidentTimeline): IncidentTimeline['entries'] {
  return incident.entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index)
    .map(({ entry }) => entry);
}

export function dateRangeQuery(
  start?: number | string | null,
  end?: number | string | null,
): string {
  if (start == null || end == null) return '';
  return new URLSearchParams({ start: String(start), end: String(end) }).toString();
}

export function dateRangeFromParams(
  start: string | null,
  end: string | null,
): DateRange | undefined {
  if (!start || !end) return undefined;
  const from = new Date(Number(start));
  const to = new Date(Number(end));
  return isNaN(from.getTime()) || isNaN(to.getTime()) ? undefined : { from, to };
}

export function incidentPath(incidentId: string, query = ''): string {
  const path = `/anomalies/incidents/${encodeURIComponent(incidentId)}`;
  return query ? `${path}?${query}` : path;
}
