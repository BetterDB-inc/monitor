import type { IncidentRecoveryStatus, IncidentTimeline } from '../../../types/anomaly';
import { metricLabel, patternLabel } from '../anomaly-display';

const OPEN_STATUSES: ReadonlySet<IncidentRecoveryStatus> = new Set([
  'active',
  'recovering',
  'degraded',
]);

export function isIncidentOpen(incident: IncidentTimeline): boolean {
  return OPEN_STATUSES.has(incident.recovery.status);
}

export function isDurationOngoing(incident: IncidentTimeline): boolean {
  return incident.recovery.recoveredAt === null && isIncidentOpen(incident);
}

export function incidentDurationMs(incident: IncidentTimeline, now: number): number {
  if (incident.recovery.recoveredAt !== null)
    return incident.recovery.recoveredAt - incident.startedAt;
  return (isIncidentOpen(incident) ? now : incident.lastEventAt) - incident.startedAt;
}

export function incidentTitle(incident: IncidentTimeline): string {
  if (incident.matchedPatterns.length > 0)
    return incident.matchedPatterns.map(patternLabel).join(', ');
  const first = orderedEntries(incident)[0];
  return first ? metricLabel(first.metricType) : 'Incident';
}

export function orderedEntries(incident: IncidentTimeline): IncidentTimeline['entries'] {
  return incident.entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index)
    .map(({ entry }) => entry);
}

export function incidentsByAnomaly(
  incidents: IncidentTimeline[] | null | undefined,
): Map<string, IncidentTimeline> {
  const byAnomaly = new Map<string, IncidentTimeline>();
  for (const incident of incidents ?? []) {
    for (const entry of incident.entries) {
      if (!byAnomaly.has(entry.anomalyId)) byAnomaly.set(entry.anomalyId, incident);
    }
  }
  return byAnomaly;
}

export function findIncidentForAnomalies(
  byAnomaly: Map<string, IncidentTimeline>,
  anomalyIds: string[],
): IncidentTimeline | undefined {
  const hits = new Map<IncidentTimeline, number>();
  for (const id of anomalyIds) {
    const incident = byAnomaly.get(id);
    if (incident) hits.set(incident, (hits.get(incident) ?? 0) + 1);
  }
  let best: IncidentTimeline | undefined;
  for (const [incident, count] of hits) {
    const bestCount = best ? hits.get(best)! : 0;
    if (count > bestCount || (count === bestCount && incident.startedAt > best!.startedAt)) {
      best = incident;
    }
  }
  return best;
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
