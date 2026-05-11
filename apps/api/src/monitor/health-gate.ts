/**
 * Health gate for automated MONITOR captures (anomaly-triggered and scheduled).
 *
 * Manual sessions are NOT subject to the gate; they only get a pre-flight warning.
 * Automated sessions ARE subject to the gate at trigger-fire time.
 *
 * The gate is a pure decision function: signals in, decision out. Signal collection
 * (INFO snapshot, recent anomaly history) is the caller's responsibility.
 */

export type HealthGateSkipReason =
  | 'memory_above_threshold'
  | 'recent_oom'
  | 'failover_in_progress'
  | 'replication_lag_elevated';

export interface HealthGateSignals {
  /** used_memory / maxmemory, in [0, 1+]. Set to 0 when maxmemory is unset (no limit). */
  memoryPct: number;
  /** Count of OOM-correlated events in the recent-OOM window. Caller computes the window. */
  oomEventsRecent: number;
  /** Replication offset delta on the replica side, in bytes. 0 on a primary or when unknown. */
  replicationLagBytes: number;
  /** True if a replication-role change was observed in the recent-failover window OR INFO reports an active failover. */
  failoverInProgress: boolean;
}

export interface HealthGateThresholds {
  /** Block when memoryPct >= this value. Default 0.85 (85% of maxmemory). */
  memoryPctThreshold: number;
  /** Block when replicationLagBytes >= this value. Default 10 MB. */
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

/**
 * Evaluate the health gate. Reasons are ordered by how badly MONITOR worsens the
 * underlying condition: memory pressure first, then active OOM, then topology
 * instability, then replication lag.
 */
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

/**
 * Read thresholds from environment with documented overrides:
 *   MONITOR_MEMORY_PCT_THRESHOLD     — integer percent (e.g. "85" for 85%, default 85)
 *   MONITOR_REPLICATION_LAG_BYTES    — integer bytes (default 10485760, i.e. 10 MB)
 */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): HealthGateThresholds {
  const memoryPct = parsePercent(env.MONITOR_MEMORY_PCT_THRESHOLD);
  const lagBytes = parsePositiveInt(env.MONITOR_REPLICATION_LAG_BYTES);

  return {
    memoryPctThreshold: memoryPct ?? DEFAULT_HEALTH_GATE_THRESHOLDS.memoryPctThreshold,
    replicationLagThresholdBytes:
      lagBytes ?? DEFAULT_HEALTH_GATE_THRESHOLDS.replicationLagThresholdBytes,
  };
}

function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0 || n > 100) return null;
  return n / 100;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return null;
  return n;
}
