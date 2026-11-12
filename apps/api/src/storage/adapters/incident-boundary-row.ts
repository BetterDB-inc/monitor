import type { StoredIncidentBoundary } from '../../common/interfaces/storage-port.interface';

export interface IncidentBoundaryRow {
  scope_id: string;
  started_at: number | string;
  anomaly_id: string;
  metric_type: string | null;
  connection_id: string | null;
}

export function toIncidentBoundary(row: IncidentBoundaryRow): StoredIncidentBoundary {
  return {
    scopeId: row.scope_id,
    startedAt: Number(row.started_at),
    anomalyId: row.anomaly_id,
    ...(row.metric_type !== null && { metricType: row.metric_type }),
    ...(row.connection_id !== null && { connectionId: row.connection_id }),
  };
}
