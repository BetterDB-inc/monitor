import type { IncidentRecoveryStatus, IncidentTimeline } from '../../../types/anomaly';

const OPEN_STATUSES: ReadonlySet<IncidentRecoveryStatus> = new Set([
  'active',
  'recovering',
  'degraded',
]);

export function isIncidentOpen(incident: IncidentTimeline): boolean {
  return OPEN_STATUSES.has(incident.recovery.status);
}

export function incidentDurationMs(incident: IncidentTimeline, now: number): number {
  if (incident.recovery.recoveredAt !== null)
    return incident.recovery.recoveredAt - incident.startedAt;
  return (isIncidentOpen(incident) ? now : incident.lastEventAt) - incident.startedAt;
}

export function orderedEntries(incident: IncidentTimeline): IncidentTimeline['entries'] {
  return incident.entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index)
    .map(({ entry }) => entry);
}

export function findIncidentForAnomalies(
  incidents: IncidentTimeline[] | undefined,
  anomalyIds: string[],
): IncidentTimeline | undefined {
  if (!incidents?.length) return undefined;
  const ids = new Set(anomalyIds);
  return incidents.find((incident) => incident.entries.some((entry) => ids.has(entry.anomalyId)));
}

export function incidentPath(incidentId: string): string {
  return `/anomalies/incidents/${encodeURIComponent(incidentId)}`;
}
