export function incidentEventPath(anomalyId: string, at: number, connectionId?: string): string {
  const query = new URLSearchParams({ at: String(at) });
  if (connectionId) query.set('connection', connectionId);
  return `/anomalies/incidents/by-event/${encodeURIComponent(anomalyId)}?${query.toString()}`;
}
