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
