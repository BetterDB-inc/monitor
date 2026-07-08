/**
 * Types for the P99 latency regression guard (valkey/valkey#3527).
 * All latency values are microseconds, sourced from INFO latencystats
 * cumulative t-digests collected by LatencystatsPollerService.
 */

export type RegressionKind = 'upgrade_regression' | 'sustained_degradation';

/** One stored latencystats point, as read back from storage. */
export interface CommandP99Point {
  command: string;
  p99Us: number;
  serverVersion: string;
  capturedAt: number;
}

/** Per-command regression detail carried on findings and webhook payloads. */
export interface CommandRegression {
  command: string;
  baselineP99Us: number;
  currentP99Us: number;
  degradationFactor: number;
  callsPerMin: number;
}

/** Commandstats delta point for the topology-refresh correlation predicate. */
export interface ClusterRefreshPoint {
  capturedAt: number;
  callsDelta: number;
}

/** Everything the pure detector needs for one evaluation tick. */
export interface DetectorInput {
  nowMs: number;
  /** Latencystats samples for the last 24h, ascending capturedAt, all commands. */
  samples: CommandP99Point[];
  /** Recent call volume per command (from commandstats deltas). */
  callsPerMin: Map<string, number>;
  /** cluster|slots + cluster|shards callsDelta samples over the last hour. */
  clusterRefreshDeltas: ClusterRefreshPoint[];
}

export interface RegressionFinding {
  kind: RegressionKind;
  previousVersion?: string;
  currentVersion: string;
  severity: 'warning' | 'critical';
  commands: CommandRegression[];
  topologyRefreshCorrelated: boolean;
  message: string;
  timestamp: number;
}
