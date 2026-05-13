export type HealthGateSkipReason =
  | 'memory_above_threshold'
  | 'recent_oom'
  | 'failover_in_progress'
  | 'replication_lag_elevated';

export interface HealthGateSignals {
  memoryPct: number;
  oomEventsRecent: number;
  replicationLagBytes: number;
  failoverInProgress: boolean;
}

export interface HealthGateThresholds {
  memoryPctThreshold: number;
  replicationLagThresholdBytes: number;
}

export interface HealthGateResult {
  allow: boolean;
  skipReason?: HealthGateSkipReason;
  signals: HealthGateSignals;
  thresholds: HealthGateThresholds;
}

export const DEFAULT_HEALTH_GATE_THRESHOLDS: HealthGateThresholds = {
  memoryPctThreshold: 0.85,
  replicationLagThresholdBytes: 10 * 1024 * 1024,
};

export function evaluateHealthGate(
  signals: HealthGateSignals,
  thresholds: HealthGateThresholds = DEFAULT_HEALTH_GATE_THRESHOLDS,
): HealthGateResult {
  const base = { signals, thresholds };

  if (signals.memoryPct >= thresholds.memoryPctThreshold) {
    return { ...base, allow: false, skipReason: 'memory_above_threshold' };
  }

  if (signals.oomEventsRecent > 0) {
    return { ...base, allow: false, skipReason: 'recent_oom' };
  }

  if (signals.failoverInProgress) {
    return { ...base, allow: false, skipReason: 'failover_in_progress' };
  }

  if (signals.replicationLagBytes >= thresholds.replicationLagThresholdBytes) {
    return { ...base, allow: false, skipReason: 'replication_lag_elevated' };
  }

  return { ...base, allow: true };
}
