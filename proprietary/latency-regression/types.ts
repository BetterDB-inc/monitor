import type { AnomalyKind } from '@app/common/interfaces/storage-port.interface';

/**
 * Types for the P99 latency regression guard (valkey/valkey#3527).
 * All latency values are microseconds. P99s are per interval (derived from consecutive
 * LATENCY HISTOGRAM snapshots) when a connection has fresh histogram data, and the cumulative
 * INFO latencystats t-digest values otherwise.
 */

export type RegressionKind = AnomalyKind;

/** Where the P99 samples came from. */
export type RegressionBasis = 'interval' | 'cumulative';

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
  /** How `samples` were derived; copied onto every finding. Defaults to 'cumulative'. */
  basis?: RegressionBasis;
}

export interface RegressionFinding {
  kind: RegressionKind;
  previousVersion?: string;
  currentVersion: string;
  severity: 'warning' | 'critical';
  commands: CommandRegression[];
  topologyRefreshCorrelated: boolean;
  basis: RegressionBasis;
  message: string;
  timestamp: number;
}
