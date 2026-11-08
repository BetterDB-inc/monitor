import type {
  ClientAnalyticsRollup,
  ClientAnalyticsStats,
  ClientRollupGroupStat,
  ClientRollupPairStat,
  ClientRollupUserStat,
  OwnClientConnection,
} from '@betterdb/shared';
import { clientPairKey, clientPairStatsByDisplayKey, emptyClientAnalyticsStats } from '@betterdb/shared';
import type { SqlDialect } from './base-sql.adapter';

/**
 * One (captured_at, user, name) group of raw client_snapshots rows. `name` and
 * `user` are '' when the stored value is NULL or empty.
 */
export interface ClientStatsGroup {
  capturedAt: number;
  name: string;
  user: string;
  count: number;
  ageSum: number;
}

interface GroupAccumulator {
  current: number;
  peak: number;
  ageSum: number;
  rows: number;
  /** Count per batch, keyed by captured_at, to derive the per-batch peak. */
  perBatch: Map<number, number>;
}

function accumulator(): GroupAccumulator {
  return { current: 0, peak: 0, ageSum: 0, rows: 0, perBatch: new Map() };
}

function add(acc: GroupAccumulator, capturedAt: number, count: number, ageSum: number): void {
  acc.ageSum += ageSum;
  acc.rows += count;
  acc.perBatch.set(capturedAt, (acc.perBatch.get(capturedAt) ?? 0) + count);
}

function finish(acc: GroupAccumulator, latest: number): void {
  let peak = 0;
  for (const count of acc.perBatch.values()) {
    if (count > peak) peak = count;
  }
  acc.peak = peak;
  acc.current = acc.perBatch.get(latest) ?? 0;
}

/**
 * Folds grouped raw rows into ClientAnalyticsStats in one pass. Shared by every
 * adapter so the semantics cannot drift:
 * - byName / byUser only track non-empty values; byUserAndName only pairs where
 *   both are non-empty. Pairs accumulate under clientPairKey(user, name), so
 *   distinct pairs never merge; the output is keyed `${user}:${name}` (see
 *   clientPairStatsByDisplayKey for two pairs sharing that key).
 * - current = count in the latest batch (latest captured_at in range), peak =
 *   largest count in any one batch, avgAge = plain mean of age over rows.
 * - peakConnections / peakTimestamp come from the largest batch; ties resolve
 *   to the earliest captured_at.
 * - uniqueClientNames / uniqueUsers count distinct non-empty values;
 *   uniqueIps is computed by the caller (it needs the addr column).
 * - timeRange is null when there are no rows.
 */
export function foldClientAnalyticsStats(
  groups: Iterable<ClientStatsGroup>,
  uniqueIps: number,
): ClientAnalyticsStats {
  const batches = new Map<number, number>();
  const byName = new Map<string, GroupAccumulator>();
  const byUser = new Map<string, GroupAccumulator>();
  const byUserAndName = new Map<string, { user: string; name: string; acc: GroupAccumulator }>();

  for (const g of groups) {
    if (g.count <= 0) continue;
    batches.set(g.capturedAt, (batches.get(g.capturedAt) ?? 0) + g.count);
    if (g.name) {
      let acc = byName.get(g.name);
      if (!acc) byName.set(g.name, (acc = accumulator()));
      add(acc, g.capturedAt, g.count, g.ageSum);
    }
    if (g.user) {
      let acc = byUser.get(g.user);
      if (!acc) byUser.set(g.user, (acc = accumulator()));
      add(acc, g.capturedAt, g.count, g.ageSum);
    }
    if (g.user && g.name) {
      const key = clientPairKey(g.user, g.name);
      let entry = byUserAndName.get(key);
      if (!entry) byUserAndName.set(key, (entry = { user: g.user, name: g.name, acc: accumulator() }));
      add(entry.acc, g.capturedAt, g.count, g.ageSum);
    }
  }

  if (batches.size === 0) {
    return { ...emptyClientAnalyticsStats(), uniqueIps };
  }

  let earliest = Infinity;
  let latest = -Infinity;
  let peakConnections = 0;
  let peakTimestamp = 0;
  for (const [capturedAt, count] of batches) {
    if (capturedAt < earliest) earliest = capturedAt;
    if (capturedAt > latest) latest = capturedAt;
    if (count > peakConnections || (count === peakConnections && capturedAt < peakTimestamp)) {
      peakConnections = count;
      peakTimestamp = capturedAt;
    }
  }

  const connectionsByName: ClientAnalyticsStats['connectionsByName'] = {};
  for (const [name, acc] of byName) {
    finish(acc, latest);
    connectionsByName[name] = { current: acc.current, peak: acc.peak, avgAge: acc.ageSum / acc.rows };
  }
  const connectionsByUser: ClientAnalyticsStats['connectionsByUser'] = {};
  for (const [user, acc] of byUser) {
    finish(acc, latest);
    connectionsByUser[user] = { current: acc.current, peak: acc.peak };
  }
  const pairs = new Map<string, ClientAnalyticsStats['connectionsByUserAndName'][string]>();
  for (const [key, { user, name, acc }] of byUserAndName) {
    finish(acc, latest);
    pairs.set(key, { user, name, current: acc.current, peak: acc.peak, avgAge: acc.ageSum / acc.rows });
  }
  const connectionsByUserAndName = clientPairStatsByDisplayKey(pairs);

  return {
    currentConnections: batches.get(latest) ?? 0,
    peakConnections,
    peakTimestamp,
    uniqueClientNames: byName.size,
    uniqueUsers: byUser.size,
    uniqueIps,
    connectionsByName,
    connectionsByUser,
    connectionsByUserAndName,
    timeRange: { earliest, latest },
  };
}

/**
 * addr with the port stripped: a trailing ':' followed by one or more digits
 * is removed, anything else is kept whole. '1.2.3.4:5678' -> '1.2.3.4',
 * '[::1]:6379' -> '[::1]', '/tmp/valkey.sock:0' -> '/tmp/valkey.sock';
 * 'host' and 'host:' are unchanged. The PostgreSQL and SQLite adapters
 * evaluate the same rule in SQL (PG_CLIENT_IP_EXPR, SQLITE_CLIENT_IP_EXPR).
 */
export function clientAddrIp(addr: string): string {
  return addr.replace(/:\d+$/, '');
}

/**
 * Key of one connection across CLIENT LIST captures. A server numbers clients
 * from 1 again after a restart, so an id alone can name two connections; the
 * address tells them apart.
 */
export function clientConnectionKey(clientId: string, addr: string): string {
  return `${clientId} ${addr}`;
}

/**
 * The monitor's own connections by CLIENT LIST id. An id can carry more than
 * one span: a closed connection and a live one that got the same id again
 * after a server restart.
 */
export type OwnClientSpans = ReadonlyMap<string, readonly OwnClientConnection[]>;

export function ownClientSpans(ownClients: Iterable<OwnClientConnection>): OwnClientSpans {
  const spans = new Map<string, OwnClientConnection[]>();
  for (const own of ownClients) {
    const known = spans.get(own.id);
    if (known === undefined) spans.set(own.id, [own]);
    else known.push(own);
  }
  return spans;
}

/**
 * Whether a row of `clientId` captured at `at` is one of the monitor's own
 * connections: the monitor held the id at that time, from the start of its
 * connect until its close (an open connection has no close). A row of the
 * same id outside every span (an application client before a server restart
 * renumbered the ids, or one handed the id after the monitor's connection
 * closed) is not.
 */
export function isOwnClientAt(spans: OwnClientSpans, clientId: string, at: number): boolean {
  const own = spans.get(clientId);
  if (own === undefined) return false;
  for (const span of own) {
    if (at >= span.connectedAt && (span.closedAt === undefined || at <= span.closedAt)) return true;
  }
  return false;
}

/**
 * Map a client_analytics_rollups row to the shared shape. pg returns BIGINT as
 * a string and JSONB already parsed; SQLite returns numbers and JSON text.
 */
export function mapClientAnalyticsRollupRow(
  row: Record<string, unknown>,
  dialect: SqlDialect,
): ClientAnalyticsRollup {
  const json = <T extends object>(value: unknown, fallback: T): T =>
    dialect.fromJson<T>(value as T | string | null) ?? fallback;
  return {
    connectionId: String(row.connection_id),
    bucketStart: Number(row.bucket_start),
    firstCapturedAt: Number(row.first_captured_at),
    lastCapturedAt: Number(row.last_captured_at),
    batchCount: Number(row.batch_count),
    rowCount: Number(row.row_count),
    lastConnections: Number(row.last_connections),
    peakConnections: Number(row.peak_connections),
    peakCapturedAt: Number(row.peak_captured_at),
    byName: json<Record<string, ClientRollupGroupStat>>(row.by_name, {}),
    byUser: json<Record<string, ClientRollupUserStat>>(row.by_user, {}),
    byUserAndName: json<Record<string, ClientRollupPairStat>>(row.by_user_name, {}),
    ips: json<string[]>(row.ips, []),
    updatedAt: Number(row.updated_at),
  };
}
