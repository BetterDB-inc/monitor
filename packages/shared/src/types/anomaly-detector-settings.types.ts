export interface AnomalyDetectorConfigEntry {
  warningZScore?: number;
  criticalZScore?: number;
  warningAbsolute?: number;
  criticalAbsolute?: number;
  consecutiveRequired?: number;
  cooldownMs?: number;
}

/** Persisted per-metric detector threshold overrides (partial fields only). */
export type AnomalyDetectorConfigMap = Partial<
  Record<string, AnomalyDetectorConfigEntry>
>;

export const ANOMALY_DETECTOR_METRICS = [
  'connections',
  'ops_per_sec',
  'memory_used',
  'input_kbps',
  'output_kbps',
  'slowlog_last_id',
  'acl_denied',
  'evicted_keys',
  'blocked_clients',
  'keyspace_misses',
  'fragmentation_ratio',
  'error_replies',
] as const;
export type AnomalyDetectorMetric = (typeof ANOMALY_DETECTOR_METRICS)[number];

/** GET /api/settings/anomaly/detectors */
export interface AnomalyDetectorSettingsResponse {
  /** Built-in defaults. A disabled absolute threshold is omitted. */
  defaults: Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry>;
  /** Stored overrides only. A disabled absolute threshold is shown as 0. */
  overrides: Partial<Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry>>;
  /** defaults + overrides, safe to read directly. A disabled absolute is omitted. */
  resolved: Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry>;
}

/** PATCH / DELETE /api/settings/anomaly/detectors responses */
export interface AnomalyDetectorUpdateResponse {
  message: string;
  config: Partial<Record<AnomalyDetectorMetric, AnomalyDetectorConfigEntry>>;
}
