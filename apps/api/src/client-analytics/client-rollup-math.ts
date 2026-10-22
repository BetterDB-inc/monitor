import {
  CLIENT_ANALYTICS_ROLLUP_BUCKET_MS,
  ClientAnalyticsRollup,
  ClientAnalyticsStats,
  ClientRollupGroupStat,
  ClientRollupPairStat,
  ClientSnapshotGroupRow,
  clientPairKey,
  clientPairStatsByDisplayKey,
  clientRollupBucketStart,
  emptyClientAnalyticsStats,
} from '@betterdb/shared';

/**
 * Longest explicit stats span (6 hours) computed exactly from raw snapshots;
 * longer spans are merged from rollup buckets. Fixed, not configurable.
 */
export const RAW_STATS_SPAN_MAX_MS = 6 * 60 * 60_000;

interface GroupBatchEntry {
  count: number;
  ageSum: number;
}

interface PairBatchEntry extends GroupBatchEntry {
  user: string;
  name: string;
}

interface BatchTotals {
  capturedAt: number;
  total: number;
  byName: Map<string, GroupBatchEntry>;
  byUser: Map<string, number>;
  byUserAndName: Map<string, PairBatchEntry>;
  ips: Set<string>;
}

function emptyRollup(connectionId: string, bucketStart: number, now: number): ClientAnalyticsRollup {
  return {
    connectionId,
    bucketStart,
    firstCapturedAt: Number.POSITIVE_INFINITY,
    lastCapturedAt: Number.NEGATIVE_INFINITY,
    batchCount: 0,
    rowCount: 0,
    lastConnections: 0,
    peakConnections: 0,
    peakCapturedAt: 0,
    byName: {},
    byUser: {},
    byUserAndName: {},
    ips: [],
    updatedAt: now,
  };
}

function cloneRollup(row: ClientAnalyticsRollup): ClientAnalyticsRollup {
  const cloneGroups = <T extends ClientRollupGroupStat>(src: Record<string, T>) => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(src)) out[k] = { ...v };
    return out;
  };
  const users: Record<string, { last: number; peak: number }> = {};
  for (const [k, v] of Object.entries(row.byUser)) users[k] = { ...v };
  // Re-keyed from the entry's own user and name, so a row stored under any
  // other key shape resumes under clientPairKey like a freshly folded one.
  const pairs: Record<string, ClientRollupPairStat> = {};
  for (const v of Object.values(row.byUserAndName)) pairs[clientPairKey(v.user, v.name)] = { ...v };
  return {
    ...row,
    byName: cloneGroups(row.byName),
    byUser: users,
    byUserAndName: pairs,
    ips: [...row.ips],
  };
}

function groupIntoBatches(groups: ClientSnapshotGroupRow[]): BatchTotals[] {
  const batches = new Map<number, BatchTotals>();
  for (const g of groups) {
    let batch = batches.get(g.capturedAt);
    if (!batch) {
      batch = {
        capturedAt: g.capturedAt,
        total: 0,
        byName: new Map(),
        byUser: new Map(),
        byUserAndName: new Map(),
        ips: new Set(),
      };
      batches.set(g.capturedAt, batch);
    }
    batch.total += g.count;
    batch.ips.add(g.ip);
    if (g.name) {
      const n = batch.byName.get(g.name) ?? { count: 0, ageSum: 0 };
      n.count += g.count;
      n.ageSum += g.ageSum;
      batch.byName.set(g.name, n);
    }
    if (g.user) {
      batch.byUser.set(g.user, (batch.byUser.get(g.user) ?? 0) + g.count);
    }
    if (g.name && g.user) {
      // Same unambiguous key as the raw path (foldClientAnalyticsStats):
      // distinct pairs never share an entry, whatever ':' they contain.
      const key = clientPairKey(g.user, g.name);
      const p = batch.byUserAndName.get(key) ?? { user: g.user, name: g.name, count: 0, ageSum: 0 };
      p.count += g.count;
      p.ageSum += g.ageSum;
      batch.byUserAndName.set(key, p);
    }
  }
  return [...batches.values()].sort((a, b) => a.capturedAt - b.capturedAt);
}

function foldGroupStats<T extends ClientRollupGroupStat, B extends GroupBatchEntry>(
  target: Record<string, T>,
  batch: Map<string, B>,
  create: (entry: B) => T,
): void {
  for (const stat of Object.values(target)) stat.last = 0;
  for (const [key, entry] of batch) {
    const stat = target[key] ?? create(entry);
    stat.last = entry.count;
    stat.peak = Math.max(stat.peak, entry.count);
    stat.ageSum += entry.ageSum;
    stat.rows += entry.count;
    target[key] = stat;
  }
}

const newGroupStat = (): ClientRollupGroupStat => ({ last: 0, peak: 0, ageSum: 0, rows: 0 });
const newPairStat = ({ user, name }: PairBatchEntry): ClientRollupPairStat => ({
  user,
  name,
  last: 0,
  peak: 0,
  ageSum: 0,
  rows: 0,
});

/**
 * Fold grouped raw rows into per-bucket rollup rows. Batches already folded
 * into a row (capturedAt <= row.lastCapturedAt) are skipped, so re-folding an
 * overlapping range is a no-op. Returns only the rows that changed.
 */
export function foldGroupsIntoRollups(
  connectionId: string,
  groups: ClientSnapshotGroupRow[],
  existing: ReadonlyMap<number, ClientAnalyticsRollup>,
  now: number,
): ClientAnalyticsRollup[] {
  const working = new Map<number, ClientAnalyticsRollup>();
  const changed = new Set<number>();

  for (const batch of groupIntoBatches(groups)) {
    const bucketStart = clientRollupBucketStart(batch.capturedAt);
    let row = working.get(bucketStart);
    if (!row) {
      const prior = existing.get(bucketStart);
      row = prior ? cloneRollup(prior) : emptyRollup(connectionId, bucketStart, now);
      working.set(bucketStart, row);
    }
    if (row.batchCount > 0 && batch.capturedAt <= row.lastCapturedAt) {
      continue;
    }

    row.batchCount += 1;
    row.rowCount += batch.total;
    row.firstCapturedAt = Math.min(row.firstCapturedAt, batch.capturedAt);
    row.lastCapturedAt = batch.capturedAt;
    row.lastConnections = batch.total;
    if (row.batchCount === 1 || batch.total > row.peakConnections) {
      row.peakConnections = batch.total;
      row.peakCapturedAt = batch.capturedAt;
    }
    foldGroupStats<ClientRollupGroupStat, GroupBatchEntry>(row.byName, batch.byName, newGroupStat);
    foldGroupStats<ClientRollupPairStat, PairBatchEntry>(row.byUserAndName, batch.byUserAndName, newPairStat);
    for (const stat of Object.values(row.byUser)) stat.last = 0;
    for (const [user, count] of batch.byUser) {
      const stat = row.byUser[user] ?? { last: 0, peak: 0 };
      stat.last = count;
      stat.peak = Math.max(stat.peak, count);
      row.byUser[user] = stat;
    }
    if (batch.ips.size > 0) {
      const ips = new Set(row.ips);
      for (const ip of batch.ips) ips.add(ip);
      row.ips = [...ips];
    }
    row.updatedAt = now;
    changed.add(bucketStart);
  }

  return [...changed].sort((a, b) => a - b).map((b) => working.get(b) as ClientAnalyticsRollup);
}

export interface MergeRollupsOptions {
  /**
   * How far behind the newest batch overall a connection's newest batch may
   * be and still count toward `current`. Defaults to
   * CLIENT_ANALYTICS_ROLLUP_BUCKET_MS; the rollup service passes
   * max(one bucket, two client analytics poll intervals).
   */
  currentCutoffMs?: number;
}

/**
 * Merge bucket rows (possibly spanning several connections) into the
 * ClientAnalyticsStats shape the full raw scan used to produce.
 *
 * currentConnections and the per-group `current` values sum each connection's
 * newest batch in the rows, but only for connections still reporting: a
 * connection counts toward `current` if its newest batch (lastCapturedAt) is
 * within `currentCutoffMs` of the newest batch overall. The rollup service
 * uses max(one bucket, two poll intervals), so one missed poll never drops a
 * connection however long the poll interval is; the default is one bucket
 * (5 minutes). A connection further behind (it stopped reporting, or was
 * removed) still contributes to the peaks, unique counts, average ages and
 * time range. A single-connection merge is unaffected: its newest batch is the
 * newest overall.
 *
 * Pairs are merged under clientPairKey(user, name), taken from each entry's
 * own user and name; see clientPairStatsByDisplayKey for the output key.
 */
export function mergeRollupsIntoStats(
  rollups: ClientAnalyticsRollup[],
  options: MergeRollupsOptions = {},
): ClientAnalyticsStats {
  const currentCutoffMs = options.currentCutoffMs ?? CLIENT_ANALYTICS_ROLLUP_BUCKET_MS;
  const stats = emptyClientAnalyticsStats();
  if (rollups.length === 0) {
    return stats;
  }

  const newest = new Map<string, ClientAnalyticsRollup>();
  for (const row of rollups) {
    const current = newest.get(row.connectionId);
    if (!current || row.lastCapturedAt > current.lastCapturedAt) {
      newest.set(row.connectionId, row);
    }
  }

  const names = new Map<string, { current: number; peak: number; ageSum: number; rows: number }>();
  const users = new Map<string, { current: number; peak: number }>();
  const pairs = new Map<string, { user: string; name: string; current: number; peak: number; ageSum: number; rows: number }>();
  const ips = new Set<string>();
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  let peak = -1;
  let peakAt = 0;

  for (const row of rollups) {
    earliest = Math.min(earliest, row.firstCapturedAt);
    latest = Math.max(latest, row.lastCapturedAt);
    if (
      row.peakConnections > peak ||
      (row.peakConnections === peak && row.peakCapturedAt < peakAt)
    ) {
      peak = row.peakConnections;
      peakAt = row.peakCapturedAt;
    }
    for (const [name, s] of Object.entries(row.byName)) {
      const acc = names.get(name) ?? { current: 0, peak: 0, ageSum: 0, rows: 0 };
      acc.peak = Math.max(acc.peak, s.peak);
      acc.ageSum += s.ageSum;
      acc.rows += s.rows;
      names.set(name, acc);
    }
    for (const [user, s] of Object.entries(row.byUser)) {
      const acc = users.get(user) ?? { current: 0, peak: 0 };
      acc.peak = Math.max(acc.peak, s.peak);
      users.set(user, acc);
    }
    for (const s of Object.values(row.byUserAndName)) {
      const key = clientPairKey(s.user, s.name);
      const acc = pairs.get(key) ?? { user: s.user, name: s.name, current: 0, peak: 0, ageSum: 0, rows: 0 };
      acc.peak = Math.max(acc.peak, s.peak);
      acc.ageSum += s.ageSum;
      acc.rows += s.rows;
      pairs.set(key, acc);
    }
    for (const ip of row.ips) ips.add(ip);
  }

  const newestOverall = Math.max(...[...newest.values()].map((r) => r.lastCapturedAt));
  for (const row of newest.values()) {
    if (newestOverall - row.lastCapturedAt > currentCutoffMs) continue;
    stats.currentConnections += row.lastConnections;
    for (const [name, s] of Object.entries(row.byName)) {
      const acc = names.get(name);
      if (acc) acc.current += s.last;
    }
    for (const [user, s] of Object.entries(row.byUser)) {
      const acc = users.get(user);
      if (acc) acc.current += s.last;
    }
    for (const s of Object.values(row.byUserAndName)) {
      const acc = pairs.get(clientPairKey(s.user, s.name));
      if (acc) acc.current += s.last;
    }
  }

  stats.peakConnections = Math.max(peak, 0);
  stats.peakTimestamp = peakAt;
  stats.uniqueClientNames = names.size;
  stats.uniqueUsers = users.size;
  stats.uniqueIps = ips.size;
  for (const [name, acc] of names) {
    stats.connectionsByName[name] = {
      current: acc.current,
      peak: acc.peak,
      avgAge: acc.rows > 0 ? acc.ageSum / acc.rows : 0,
    };
  }
  for (const [user, acc] of users) {
    stats.connectionsByUser[user] = { current: acc.current, peak: acc.peak };
  }
  const pairStats = new Map<string, ClientAnalyticsStats['connectionsByUserAndName'][string]>();
  for (const [key, acc] of pairs) {
    pairStats.set(key, {
      user: acc.user,
      name: acc.name,
      current: acc.current,
      peak: acc.peak,
      avgAge: acc.rows > 0 ? acc.ageSum / acc.rows : 0,
    });
  }
  stats.connectionsByUserAndName = clientPairStatsByDisplayKey(pairStats);
  stats.timeRange = { earliest, latest };
  return stats;
}
