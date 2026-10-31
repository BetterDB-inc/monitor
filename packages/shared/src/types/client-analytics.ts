export interface StoredClientSnapshot {
  id: number;
  clientId: string;
  addr: string;
  name: string;
  user: string;
  db: number;
  cmd: string;
  age: number;
  idle: number;
  flags: string;
  sub: number;
  psub: number;
  qbuf: number;
  qbufFree: number;
  obl: number;
  oll: number;
  omem: number;
  capturedAt: number;
  sourceHost: string;
  sourcePort: number;
  connectionId?: string;
}

export interface ClientSnapshotQueryOptions {
  clientName?: string;
  user?: string;
  addr?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
  connectionId?: string;
}

export interface NewClientConnectionGroup {
  name: string;
  user: string;
  ip: string;
  count: number;
}

export interface ClientTimeSeriesPoint {
  timestamp: number;
  totalConnections: number;
  byName: Record<string, number>;
  byUser: Record<string, number>;
  byAddr: Record<string, number>;
}

/**
 * Client analytics summary for one connection (or all connections).
 *
 * The figures do not all cover the same span:
 * - peakConnections / peakTimestamp: the whole rollup retention
 *   (CLIENT_ANALYTICS_ROLLUP_RETENTION_DAYS, default 90 days) when served from
 *   the aggregator's latest stats (the Prometheus peak gauge and
 *   GET /client-analytics/stats for one connection without a range); otherwise
 *   the requested range (or the default window when no range is given).
 * - unique counts, average ages and the per-name / per-user / per-pair `peak`
 *   values: the window (CLIENT_ANALYTICS_WINDOW_MS, default 24 hours) for the
 *   latest stats, or the requested range.
 * - currentConnections and the per-group `current` values: the newest snapshot
 *   batch inside that span. Merged across several connections, each
 *   connection's newest batch is summed, but only for connections still
 *   reporting: a connection counts toward `current` if its newest batch is
 *   within max(one bucket, two poll intervals) of the newest batch overall,
 *   that is max(CLIENT_ANALYTICS_ROLLUP_BUCKET_MS (5 minutes),
 *   2 x clientAnalyticsPollIntervalMs). One further behind is left out of
 *   `current`, while still counting towards the peaks, unique counts, average
 *   ages and time range.
 * - connectionsByUserAndName is keyed `${user}:${name}` (kept for API
 *   compatibility; read user and name from the entry). Pairs are accumulated
 *   separately internally, but two distinct pairs whose user or name contains
 *   ':' can map to the same key (('a:b', 'c') and ('a', 'b:c') both give
 *   'a:b:c'): only one of them is returned under that key, the one whose
 *   clientPairKey() sorts first, so the counts are never summed across pairs.
 */
export interface ClientAnalyticsStats {
  currentConnections: number;
  peakConnections: number;
  peakTimestamp: number;
  uniqueClientNames: number;
  uniqueUsers: number;
  uniqueIps: number;
  connectionsByName: Record<string, { current: number; peak: number; avgAge: number }>;
  connectionsByUser: Record<string, { current: number; peak: number }>;
  connectionsByUserAndName: Record<string, { user: string; name: string; current: number; peak: number; avgAge: number }>;
  timeRange: { earliest: number; latest: number } | null;
}

/** Stats for an empty range: zero counts, empty breakdowns, no time range. */
export function emptyClientAnalyticsStats(): ClientAnalyticsStats {
  return {
    currentConnections: 0,
    peakConnections: 0,
    peakTimestamp: 0,
    uniqueClientNames: 0,
    uniqueUsers: 0,
    uniqueIps: 0,
    connectionsByName: {},
    connectionsByUser: {},
    connectionsByUserAndName: {},
    timeRange: null,
  };
}

// Advanced Analytics Interfaces

export interface CommandDistributionParams {
  startTime?: number;  // Unix ms, default: 1 hour ago
  endTime?: number;    // Unix ms, default: now
  groupBy?: 'client_name' | 'user' | 'addr';  // default: client_name
}

export interface CommandDistributionResponse {
  timeRange: { start: number; end: number };
  totalSnapshots: number;
  distribution: Array<{
    identifier: string;        // client name, user, or addr
    commands: Record<string, number>;  // { GET: 1500, SET: 300, HGET: 200 }
    totalCommands: number;
    topCommand: string;
    activityPercentage: number;  // % of total snapshots this client appeared in
  }>;
}

export interface IdleConnectionsParams {
  idleThresholdSeconds?: number;  // default: 300 (5 min)
  minOccurrences?: number;        // default: 10 (seen idle in 10+ snapshots)
}

export interface IdleConnectionsResponse {
  threshold: number;
  connections: Array<{
    identifier: string;
    addr: string;
    user: string;
    avgIdleSeconds: number;
    maxIdleSeconds: number;
    occurrences: number;
    firstSeen: number;
    lastSeen: number;
    recommendation: string;  // e.g., "Consider connection pooling" or "Possible zombie connection"
  }>;
  summary: {
    totalIdleConnections: number;
    potentialWastedResources: string;  // e.g., "12 connections idle >5 min"
  };
}

export interface BufferAnomaliesParams {
  startTime?: number;
  endTime?: number;
  qbufThreshold?: number;   // default: 1MB
  omemThreshold?: number;   // default: 10MB
}

export interface BufferAnomaliesResponse {
  anomalies: Array<{
    identifier: string;
    addr: string;
    timestamp: number;
    qbuf: number;
    qbufFree: number;
    obl: number;
    oll: number;
    omem: number;
    lastCommand: string;
    severity: 'warning' | 'critical';
    recommendation: string;
  }>;
  stats: {
    avgQbuf: number;
    maxQbuf: number;
    avgOmem: number;
    maxOmem: number;
    p95Qbuf: number;
    p95Omem: number;
  };
}

export interface ActivityTimelineParams {
  startTime?: number;
  endTime?: number;
  bucketSizeMinutes?: number;  // default: 5
  client?: string;             // optional filter by client name
}

export interface ActivityTimelineResponse {
  buckets: Array<{
    timestamp: number;
    uniqueClients: number;
    totalConnections: number;
    commandBreakdown: Record<string, number>;
    avgIdleSeconds: number;
    maxQbuf: number;
    maxOmem: number;
  }>;
}

export interface SpikeDetectionParams {
  startTime?: number;
  endTime?: number;
  sensitivityMultiplier?: number;  // default: 2 (2x standard deviation)
}

export interface SpikeDetectionResponse {
  spikes: Array<{
    timestamp: number;
    metric: 'connections' | 'commands' | 'buffer';
    value: number;
    baseline: number;
    deviation: number;
    contributingClients: Array<{
      identifier: string;
      contribution: number;  // % of spike attributable to this client
    }>;
  }>;
  baselineStats: {
    avgConnections: number;
    stdDevConnections: number;
    avgCommandsPerMinute: number;
  };
}

// Client analytics rollups
//
// Raw client_snapshots rows are folded into one row per connection per
// fixed-size time bucket by the background aggregator. Every field of
// ClientAnalyticsStats can be reproduced exactly by merging bucket rows over a
// range, so readers never aggregate over raw rows for anything historical.
// The bucket size is fixed: changing it would make existing rows unmergeable.

export const CLIENT_ANALYTICS_ROLLUP_BUCKET_MS = 5 * 60 * 1000;

export function clientRollupBucketStart(timestampMs: number): number {
  return Math.floor(timestampMs / CLIENT_ANALYTICS_ROLLUP_BUCKET_MS) * CLIENT_ANALYTICS_ROLLUP_BUCKET_MS;
}

/** Per-group stat inside one bucket. `last` is the count in the bucket's newest batch (0 when absent from it), `peak` the largest count in any one batch, `ageSum`/`rows` give the weighted average age across buckets. */
export interface ClientRollupGroupStat {
  last: number;
  peak: number;
  ageSum: number;
  rows: number;
}

/**
 * Unambiguous internal key for a (user, name) pair: JSON.stringify([user, name]).
 * Distinct pairs never share a key, unlike `${user}:${name}` (which merges
 * ('a:b', 'c') with ('a', 'b:c')).
 */
export function clientPairKey(user: string, name: string): string {
  return JSON.stringify([user, name]);
}

/**
 * Re-key per-pair stats from clientPairKey(user, name) to the external
 * `${user}:${name}` key. That key is ambiguous when user or name contains ':'
 * (('a:b', 'c') and ('a', 'b:c') both give 'a:b:c'); the pairs stay separate
 * and the one whose clientPairKey sorts first is returned under the shared key,
 * so the choice does not depend on iteration order and the raw and rollup paths
 * agree. Counts are never summed across pairs. Used by both folds
 * (foldClientAnalyticsStats and mergeRollupsIntoStats).
 */
export function clientPairStatsByDisplayKey<T extends { user: string; name: string }>(
  pairs: ReadonlyMap<string, T>,
): Record<string, T> {
  const out: Record<string, T> = {};
  const owner = new Map<string, string>();
  for (const [key, stat] of pairs) {
    const display = `${stat.user}:${stat.name}`;
    const current = owner.get(display);
    if (current !== undefined && current <= key) continue;
    owner.set(display, key);
    out[display] = stat;
  }
  return out;
}

/** Per-(user, name) stat inside one bucket. The pair is stored explicitly, so readers never parse the key. */
export interface ClientRollupPairStat extends ClientRollupGroupStat {
  user: string;
  name: string;
}

export interface ClientRollupUserStat {
  last: number;
  peak: number;
}

export interface ClientAnalyticsRollup {
  connectionId: string;
  /** Inclusive bucket start, a multiple of CLIENT_ANALYTICS_ROLLUP_BUCKET_MS. */
  bucketStart: number;
  firstCapturedAt: number;
  lastCapturedAt: number;
  /** Distinct captured_at values (poller batches) folded into this bucket. */
  batchCount: number;
  /** Raw rows folded into this bucket. */
  rowCount: number;
  /** Rows in the bucket's newest batch. */
  lastConnections: number;
  /** Largest batch in the bucket and when it was captured. */
  peakConnections: number;
  peakCapturedAt: number;
  /** Keyed by client name; names that are empty are not tracked. */
  byName: Record<string, ClientRollupGroupStat>;
  /** Keyed by ACL user; empty users are not tracked. */
  byUser: Record<string, ClientRollupUserStat>;
  /**
   * Keyed by clientPairKey(user, name), i.e. JSON.stringify([user, name]), so
   * distinct pairs never collide; only pairs where both are non-empty. Read
   * user and name from the entry rather than parsing the key.
   */
  byUserAndName: Record<string, ClientRollupPairStat>;
  /** Distinct client IPs (addr without port) seen in the bucket. */
  ips: string[];
  updatedAt: number;
}

/** One grouped raw row, as read by the aggregator: all client_snapshots rows sharing (captured_at, name, user, ip). */
export interface ClientSnapshotGroupRow {
  capturedAt: number;
  /** '' when the stored name is NULL or empty. */
  name: string;
  /** '' when the stored user is NULL or empty. */
  user: string;
  /** addr with the port stripped. */
  ip: string;
  count: number;
  ageSum: number;
}
