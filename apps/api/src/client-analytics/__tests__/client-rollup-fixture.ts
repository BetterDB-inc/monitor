import {
  ClientAnalyticsRollup,
  ClientAnalyticsStats,
  ClientSnapshotGroupRow,
} from '@betterdb/shared';

export interface RawClientRow {
  connectionId: string;
  capturedAt: number;
  name: string;
  user: string;
  ip: string;
  age: number;
}

/** Deterministic PRNG so fixtures are stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['api', 'worker', 'cron', '', 'billing'];
const USERS = ['default', 'app', '', 'admin'];
const IPS = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '192.168.1.7', '172.16.0.4'];

/**
 * Two connections, `batches` poller batches each, 60s apart, starting off a
 * bucket boundary so batches spread across several 5-minute buckets.
 */
export function buildRawFixture(
  options: { start?: number; batches?: number; connections?: string[]; seed?: number; stepMs?: number } = {},
): RawClientRow[] {
  const start = options.start ?? 1_700_000_123_000;
  const batches = options.batches ?? 30;
  const connections = options.connections ?? ['conn-a', 'conn-b'];
  const rand = mulberry32(options.seed ?? 42);
  const stepMs = options.stepMs ?? 60_000;
  const rows: RawClientRow[] = [];
  connections.forEach((connectionId, ci) => {
    for (let b = 0; b < batches; b++) {
      const capturedAt = start + b * stepMs + ci * 7_000;
      const size = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < size; i++) {
        rows.push({
          connectionId,
          capturedAt,
          name: NAMES[Math.floor(rand() * NAMES.length)],
          user: USERS[Math.floor(rand() * USERS.length)],
          ip: IPS[Math.floor(rand() * IPS.length)],
          age: Math.floor(rand() * 5000),
        });
      }
    }
  });
  return rows;
}

/** What storage.getClientSnapshotGroups returns for these raw rows. */
export function groupsFromRaw(
  raw: RawClientRow[],
  connectionId: string,
  startExclusive = Number.NEGATIVE_INFINITY,
  endInclusive = Number.POSITIVE_INFINITY,
): ClientSnapshotGroupRow[] {
  const map = new Map<string, ClientSnapshotGroupRow>();
  for (const r of raw) {
    if (r.connectionId !== connectionId) continue;
    if (r.capturedAt <= startExclusive || r.capturedAt > endInclusive) continue;
    const key = JSON.stringify([r.capturedAt, r.name, r.user, r.ip]);
    const g = map.get(key) ?? {
      capturedAt: r.capturedAt,
      name: r.name,
      user: r.user,
      ip: r.ip,
      count: 0,
      ageSum: 0,
    };
    g.count += 1;
    g.ageSum += r.age;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.capturedAt - b.capturedAt);
}

/** Naive reference over raw rows, with the semantics the rollups must reproduce. */
export function referenceStats(raw: RawClientRow[]): ClientAnalyticsStats {
  const stats: ClientAnalyticsStats = {
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
  if (raw.length === 0) return stats;

  const batches = new Map<string, RawClientRow[]>();
  const newestAt = new Map<string, number>();
  for (const r of raw) {
    const key = `${r.connectionId}|${r.capturedAt}`;
    const list = batches.get(key) ?? [];
    list.push(r);
    batches.set(key, list);
    newestAt.set(r.connectionId, Math.max(newestAt.get(r.connectionId) ?? -Infinity, r.capturedAt));
  }

  let peak = -1;
  let peakAt = 0;
  const namePeak = new Map<string, number>();
  const userPeak = new Map<string, number>();
  const pairPeak = new Map<string, number>();
  const current = { name: new Map<string, number>(), user: new Map<string, number>(), pair: new Map<string, number>() };
  for (const rows of batches.values()) {
    const at = rows[0].capturedAt;
    if (rows.length > peak || (rows.length === peak && at < peakAt)) {
      peak = rows.length;
      peakAt = at;
    }
    const isNewest = newestAt.get(rows[0].connectionId) === at;
    const nameCounts = new Map<string, number>();
    const userCounts = new Map<string, number>();
    const pairCounts = new Map<string, number>();
    for (const r of rows) {
      if (r.name) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1);
      if (r.user) userCounts.set(r.user, (userCounts.get(r.user) ?? 0) + 1);
      if (r.name && r.user) {
        const k = `${r.user}:${r.name}`;
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
      }
    }
    const apply = (counts: Map<string, number>, peaks: Map<string, number>, cur: Map<string, number>) => {
      for (const [k, c] of counts) {
        peaks.set(k, Math.max(peaks.get(k) ?? 0, c));
        if (isNewest) cur.set(k, (cur.get(k) ?? 0) + c);
      }
    };
    apply(nameCounts, namePeak, current.name);
    apply(userCounts, userPeak, current.user);
    apply(pairCounts, pairPeak, current.pair);
    if (isNewest) stats.currentConnections += rows.length;
  }
  stats.peakConnections = peak;
  stats.peakTimestamp = peakAt;

  const ageAcc = (pick: (r: RawClientRow) => string | null) => {
    const acc = new Map<string, { sum: number; n: number }>();
    for (const r of raw) {
      const k = pick(r);
      if (k === null) continue;
      const a = acc.get(k) ?? { sum: 0, n: 0 };
      a.sum += r.age;
      a.n += 1;
      acc.set(k, a);
    }
    return acc;
  };
  for (const [name, a] of ageAcc((r) => (r.name ? r.name : null))) {
    stats.connectionsByName[name] = { current: current.name.get(name) ?? 0, peak: namePeak.get(name) ?? 0, avgAge: a.sum / a.n };
  }
  for (const user of userPeak.keys()) {
    stats.connectionsByUser[user] = { current: current.user.get(user) ?? 0, peak: userPeak.get(user) ?? 0 };
  }
  const pairOf = new Map<string, { user: string; name: string }>();
  for (const r of raw) if (r.name && r.user) pairOf.set(`${r.user}:${r.name}`, { user: r.user, name: r.name });
  for (const [key, a] of ageAcc((r) => (r.name && r.user ? `${r.user}:${r.name}` : null))) {
    const { user, name } = pairOf.get(key) as { user: string; name: string };
    stats.connectionsByUserAndName[key] = {
      user,
      name,
      current: current.pair.get(key) ?? 0,
      peak: pairPeak.get(key) ?? 0,
      avgAge: a.sum / a.n,
    };
  }
  stats.uniqueClientNames = Object.keys(stats.connectionsByName).length;
  stats.uniqueUsers = Object.keys(stats.connectionsByUser).length;
  stats.uniqueIps = new Set(raw.map((r) => r.ip)).size;
  stats.timeRange = {
    earliest: Math.min(...raw.map((r) => r.capturedAt)),
    latest: Math.max(...raw.map((r) => r.capturedAt)),
  };
  return stats;
}

/** Round float averages so exact-equality comparisons are stable. */
export function normalizeStats(stats: ClientAnalyticsStats): ClientAnalyticsStats {
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  const byName: ClientAnalyticsStats['connectionsByName'] = {};
  for (const [k, v] of Object.entries(stats.connectionsByName)) byName[k] = { ...v, avgAge: round(v.avgAge) };
  const byPair: ClientAnalyticsStats['connectionsByUserAndName'] = {};
  for (const [k, v] of Object.entries(stats.connectionsByUserAndName)) byPair[k] = { ...v, avgAge: round(v.avgAge) };
  return { ...stats, connectionsByName: byName, connectionsByUserAndName: byPair };
}

export function rollupsByBucket(rows: ClientAnalyticsRollup[]): Map<number, ClientAnalyticsRollup> {
  return new Map(rows.map((r) => [r.bucketStart, r]));
}
