import type {
  ClientAnalyticsRollup,
  ClientAnalyticsStats,
  ClientRollupGroupStat,
  ClientRollupPairStat,
  ClientRollupUserStat,
  ClientCaptureGroupRow,
  ClientCaptureSummary,
  ClientConnectionRow,
  StoredClientSnapshot,
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
 * How far apart, at most, two opening estimates (`captured_at - age * 1000`)
 * of one (client_id, addr) are for the same connection. A Unix socket gives
 * every client the same addr, so after a server restart a new connection can
 * carry the id and addr of one from before it; it opened later, by more than
 * this. The SQL adapters use the same value as their RANGE frame.
 */
export const CLIENT_REOPEN_TOLERANCE_MS = 30_000;

/**
 * The opening of the connection behind `estimate`, among the ascending opening
 * estimates of one (client_id, addr): the earliest within
 * CLIENT_REOPEN_TOLERANCE_MS of it, as the SQL adapters' MIN over
 * `RANGE BETWEEN CLIENT_REOPEN_TOLERANCE_MS PRECEDING AND ... FOLLOWING`.
 */
export function connectionOpenedAt(sortedEstimates: readonly number[], estimate: number): number {
  let low = 0;
  let high = sortedEstimates.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sortedEstimates[mid] < estimate - CLIENT_REOPEN_TOLERANCE_MS) low = mid + 1;
    else high = mid;
  }
  return sortedEstimates[low] ?? estimate;
}

/** The client_snapshots columns retry attribution aggregates. */
export type ClientCaptureRow = Pick<
  StoredClientSnapshot,
  'capturedAt' | 'clientId' | 'addr' | 'age' | 'name' | 'user'
>;

/**
 * A row of the SQL adapters' getClientCaptureSummary statement: one (name,
 * user, ip) group of one capture (`kind` 'group'), or one connection with its
 * first capture in `captured_at` (`kind` 'connection'). pg returns BIGINT as a
 * string.
 */
export interface ClientCaptureSqlRow {
  kind: 'group' | 'connection';
  captured_at: number | string;
  client_id: string | null;
  addr: string | null;
  name: string;
  user_name: string;
  ip: string;
  count: number | string | null;
  oldest_age: number | string | null;
  max_client_id: number | string | null;
  opened_at: number | string | null;
}

/** Maps the rows of the SQL adapters' getClientCaptureSummary statement. */
export function clientCaptureSummaryFromSql(rows: ClientCaptureSqlRow[]): ClientCaptureSummary {
  const summary: ClientCaptureSummary = { captures: [], connections: [] };
  for (const row of rows) {
    const { name, user_name: user, ip } = row;
    if (row.kind === 'connection') {
      summary.connections.push({
        clientId: String(row.client_id),
        addr: String(row.addr),
        name,
        user,
        ip,
        openedAt: Number(row.opened_at),
        firstCapturedAt: Number(row.captured_at),
      });
    } else {
      summary.captures.push({
        capturedAt: Number(row.captured_at),
        name,
        user,
        ip,
        count: Number(row.count),
        oldestAge: Number(row.oldest_age),
        maxClientId: Number(row.max_client_id ?? 0),
      });
    }
  }
  return summary;
}

/**
 * The memory adapter's getClientCaptureSummary: the aggregation the SQL
 * adapters run in SQL, over rows already narrowed to one connection, the range
 * and no replica or master links, in insertion order. A connection is a
 * (clientId, addr) and its opening (connectionOpenedAt); it takes the name and
 * user of its newest row, the later insert on a tie. A (clientId, addr) listed
 * twice in one capture (two polls stored with the same timestamp) counts once
 * in its group, as the SQL adapters' COUNT(DISTINCT).
 */
export function summarizeClientCaptures(rows: readonly ClientCaptureRow[]): ClientCaptureSummary {
  const estimates = new Map<string, number[]>();
  for (const row of rows) {
    const key = clientConnectionKey(row.clientId, row.addr);
    const known = estimates.get(key);
    if (known === undefined) estimates.set(key, [row.capturedAt - row.age * 1000]);
    else known.push(row.capturedAt - row.age * 1000);
  }
  for (const known of estimates.values()) known.sort((a, b) => a - b);
  const openedAtOf = (row: ClientCaptureRow) =>
    connectionOpenedAt(
      estimates.get(clientConnectionKey(row.clientId, row.addr))!,
      row.capturedAt - row.age * 1000,
    );
  const connectionOf = (row: ClientCaptureRow) =>
    `${clientConnectionKey(row.clientId, row.addr)} ${openedAtOf(row)}`;
  const newest = new Map<string, ClientCaptureRow>();
  for (const row of rows) {
    const key = connectionOf(row);
    const known = newest.get(key);
    if (known === undefined || row.capturedAt >= known.capturedAt) newest.set(key, row);
  }
  const groups = new Map<string, ClientCaptureGroupRow>();
  const members = new Map<string, Set<string>>();
  const connections = new Map<string, ClientConnectionRow>();
  for (const row of rows) {
    const key = connectionOf(row);
    const { name, user } = newest.get(key)!;
    const ip = clientAddrIp(row.addr);
    // Ids are decimal; anything else has no bearing on the growth.
    const clientId = /^\d+$/.test(row.clientId) ? Number(row.clientId) : 0;
    const groupKey = JSON.stringify([row.capturedAt, name, user, ip]);
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, {
        capturedAt: row.capturedAt,
        name,
        user,
        ip,
        count: 1,
        oldestAge: row.age,
        maxClientId: clientId,
      });
      members.set(groupKey, new Set([clientConnectionKey(row.clientId, row.addr)]));
    } else {
      const listed = members.get(groupKey)!;
      listed.add(clientConnectionKey(row.clientId, row.addr));
      group.count = listed.size;
      group.oldestAge = Math.max(group.oldestAge, row.age);
      group.maxClientId = Math.max(group.maxClientId, clientId);
    }
    const connection = connections.get(key);
    if (connection === undefined) {
      connections.set(key, {
        clientId: row.clientId,
        addr: row.addr,
        name,
        user,
        ip,
        openedAt: openedAtOf(row),
        firstCapturedAt: row.capturedAt,
      });
    } else {
      connection.firstCapturedAt = Math.min(connection.firstCapturedAt, row.capturedAt);
    }
  }
  return { captures: [...groups.values()], connections: [...connections.values()] };
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
