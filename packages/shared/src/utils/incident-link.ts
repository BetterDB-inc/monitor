export const INCIDENT_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

export function incidentEventPath(anomalyId: string, at: number, connectionId?: string): string {
  const query = new URLSearchParams({ at: String(at) });
  if (connectionId) query.set('connection', connectionId);
  return `/anomalies/incidents/by-event/${encodeURIComponent(anomalyId)}?${query.toString()}`;
}

export function incidentEventUrl(
  baseUrl: string,
  anomalyId: string,
  at: number,
  connectionId?: string,
): string {
  return `${baseUrl.replace(/\/$/, '')}${incidentEventPath(anomalyId, at, connectionId)}`;
}
