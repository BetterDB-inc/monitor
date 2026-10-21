import type {
  ClientAnalyticsRollup,
  ClientAnalyticsStats,
  StoredClientSnapshot,
} from '@betterdb/shared';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';

/** Shared fixture and naive reference for the client analytics rollup suites (unit and PostgreSQL e2e). */

export const T0 = 1_700_000_100_000; // not bucket-aligned on purpose
export const BATCH_MS = 60_000;
export const BATCHES = 20;
export const CONNECTIONS = ['conn-a', 'conn-b', 'conn-c'] as const;

const NAMES = ['api', 'worker', '', 'cron', 'name with space'];
const USERS = ['default', 'app', '', 'reporting'];

function batchSize(connIndex: number, batch: number): number {
  if (connIndex === 0) return batch === 7 ? 15 : 5 + (batch % 4); // single clear peak at batch 7
  if (connIndex === 1) return batch === 3 || batch === 12 ? 12 : 4 + (batch % 3); // tie: earliest wins
  return batch % 5 === 0 ? 0 : 3 + (batch % 2); // gaps: some batches have no rows
}

export type FixtureRow = Omit<StoredClientSnapshot, 'id'> & { connectionId: string };

export function buildFixture(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  CONNECTIONS.forEach((connectionId, c) => {
    for (let b = 0; b < BATCHES; b++) {
      const size = batchSize(c, b);
      for (let k = 0; k < size; k++) {
        const seed = c * 1000 + b * 31 + k * 7;
        const ipOctet = (k + c) % 4;
        const addr = k % 6 === 5 ? '/tmp/valkey.sock' : `10.0.${c}.${ipOctet}:${40000 + seed}`;
        rows.push({
          clientId: `${connectionId}-${b}-${k}`,
          addr,
          name: NAMES[(k + b) % NAMES.length],
          user: USERS[(k * 3 + c) % USERS.length],
          db: 0,
          cmd: 'get',
          age: (seed * 13) % 977,
          idle: 0,
          flags: 'N',
          sub: 0,
          psub: 0,
          qbuf: 0,
          qbufFree: 0,
          obl: 0,
          oll: 0,
          omem: 0,
          capturedAt: T0 + b * BATCH_MS,
          sourceHost: 'localhost',
          sourcePort: 6379,
          connectionId,
        });
      }
    }
  });
  return rows;
}

export async function seedFixture(storage: StoragePort, rows: FixtureRow[]): Promise<void> {
  for (const connectionId of CONNECTIONS) {
    const own = rows.filter((r) => r.connectionId === connectionId);
    const byBatch = new Map<number, FixtureRow[]>();
    for (const r of own) {
      byBatch.set(r.capturedAt, [...(byBatch.get(r.capturedAt) ?? []), r]);
    }
    for (const batch of byBatch.values()) {
      await storage.saveClientSnapshot(
        batch.map((r) => ({ ...r, id: 0 })),
        connectionId,
      );
    }
  }
}

/** Naive reference straight from the semantics: filter raw rows, then count. */
export function referenceStats(
  rows: FixtureRow[],
  startTime?: number,
  endTime?: number,
  connectionId?: string,
): ClientAnalyticsStats {
  const f = rows.filter(
    (r) =>
      (!connectionId || r.connectionId === connectionId) &&
      (!startTime || r.capturedAt >= startTime) &&
      (!endTime || r.capturedAt <= endTime),
  );
  const ipOf = (addr: string) => addr.split(':')[0];
  const uniqueIps = new Set(f.map((r) => ipOf(r.addr))).size;
  if (f.length === 0) {
    return {
      currentConnections: 0,
      peakConnections: 0,
      peakTimestamp: 0,
      uniqueClientNames: 0,
      uniqueUsers: 0,
      uniqueIps,
      connectionsByName: {},
      connectionsByUser: {},
      connectionsByUserAndName: {},
      timeRange: null,
    };
  }
  const times = [...new Set(f.map((r) => r.capturedAt))].sort((a, b) => a - b);
  const latest = times[times.length - 1];
  const countAt = (t: number, pred: (r: FixtureRow) => boolean) =>
    f.filter((r) => r.capturedAt === t && pred(r)).length;
  const peakOf = (pred: (r: FixtureRow) => boolean) => Math.max(...times.map((t) => countAt(t, pred)));
  const avgAge = (pred: (r: FixtureRow) => boolean) => {
    const m = f.filter(pred);
    return m.reduce((s, r) => s + r.age, 0) / m.length;
  };

  let peakConnections = 0;
  let peakTimestamp = 0;
  for (const t of times) {
    const n = countAt(t, () => true);
    if (n > peakConnections) {
      peakConnections = n;
      peakTimestamp = t;
    }
  }

  const names = [...new Set(f.map((r) => r.name).filter(Boolean))];
  const users = [...new Set(f.map((r) => r.user).filter(Boolean))];
  const connectionsByName: ClientAnalyticsStats['connectionsByName'] = {};
  for (const name of names) {
    const pred = (r: FixtureRow) => r.name === name;
    connectionsByName[name] = { current: countAt(latest, pred), peak: peakOf(pred), avgAge: avgAge(pred) };
  }
  const connectionsByUser: ClientAnalyticsStats['connectionsByUser'] = {};
  for (const user of users) {
    const pred = (r: FixtureRow) => r.user === user;
    connectionsByUser[user] = { current: countAt(latest, pred), peak: peakOf(pred) };
  }
  const connectionsByUserAndName: ClientAnalyticsStats['connectionsByUserAndName'] = {};
  for (const user of users) {
    for (const name of names) {
      const pred = (r: FixtureRow) => r.user === user && r.name === name;
      if (!f.some(pred)) continue;
      connectionsByUserAndName[`${user}:${name}`] = {
        user,
        name,
        current: countAt(latest, pred),
        peak: peakOf(pred),
        avgAge: avgAge(pred),
      };
    }
  }

  return {
    currentConnections: countAt(latest, () => true),
    peakConnections,
    peakTimestamp,
    uniqueClientNames: names.length,
    uniqueUsers: users.length,
    uniqueIps,
    connectionsByName,
    connectionsByUser,
    connectionsByUserAndName,
    timeRange: { earliest: times[0], latest },
  };
}

/** Bounds exercised by the parity/identity tests: unbounded, a middle window, an empty window. */
export const STATS_RANGES: Array<[string, number | undefined, number | undefined]> = [
  ['unbounded', undefined, undefined],
  ['bounded', T0 + 4 * BATCH_MS, T0 + 13 * BATCH_MS],
  ['start only', T0 + 9 * BATCH_MS, undefined],
  ['empty window', T0 + 100 * BATCH_MS, T0 + 200 * BATCH_MS],
];

export function rollup(
  connectionId: string,
  bucketStart: number,
  overrides: Partial<ClientAnalyticsRollup> = {},
): ClientAnalyticsRollup {
  return {
    connectionId,
    bucketStart,
    firstCapturedAt: bucketStart + 1_000,
    lastCapturedAt: bucketStart + 241_000,
    batchCount: 5,
    rowCount: 42,
    lastConnections: 8,
    peakConnections: 11,
    peakCapturedAt: bucketStart + 61_000,
    byName: { api: { last: 3, peak: 5, ageSum: 120, rows: 20 } },
    byUser: { default: { last: 6, peak: 9 } },
    byUserAndName: { 'default:api': { last: 3, peak: 5, ageSum: 120, rows: 20 } },
    ips: ['10.0.0.1', '10.0.0.2'],
    updatedAt: 1_700_000_999_000,
    ...overrides,
  };
}

const PEAK_BUCKET = 300_000;

/**
 * Rollup rows for getClientAnalyticsRollupPeak: conn-a peaks at 9 twice
 * (buckets 2 and 3, the earlier capture wins the tie), conn-b's larger peak
 * must never leak into conn-a.
 */
export function peakRollups(): ClientAnalyticsRollup[] {
  const b = (n: number) => n * PEAK_BUCKET;
  return [
    rollup('conn-a', b(1), { peakConnections: 5, peakCapturedAt: b(1) + 10_000 }),
    rollup('conn-a', b(3), { peakConnections: 9, peakCapturedAt: b(3) + 5_000 }),
    rollup('conn-a', b(2), { peakConnections: 9, peakCapturedAt: b(2) + 200_000 }),
    rollup('conn-a', b(4), { peakConnections: 7, peakCapturedAt: b(4) + 1_000 }),
    rollup('conn-b', b(1), { peakConnections: 20, peakCapturedAt: b(1) + 3_000 }),
  ];
}

/** [label, connectionId, sinceBucket, expected peak]. */
export const PEAK_CASES: Array<[string, string, number, { peak: number; capturedAt: number } | null]> = [
  ['all buckets, tie to the earliest capture', 'conn-a', 0, { peak: 9, capturedAt: 2 * PEAK_BUCKET + 200_000 }],
  ['cut-off on a bucket start is inclusive', 'conn-a', 2 * PEAK_BUCKET, { peak: 9, capturedAt: 2 * PEAK_BUCKET + 200_000 }],
  ['cut-off past the first tied bucket', 'conn-a', 2 * PEAK_BUCKET + 1, { peak: 9, capturedAt: 3 * PEAK_BUCKET + 5_000 }],
  ['cut-off leaves only the newest bucket', 'conn-a', 4 * PEAK_BUCKET, { peak: 7, capturedAt: 4 * PEAK_BUCKET + 1_000 }],
  ['cut-off past every bucket', 'conn-a', 5 * PEAK_BUCKET, null],
  ['scoped to the connection', 'conn-b', 0, { peak: 20, capturedAt: PEAK_BUCKET + 3_000 }],
  ['unknown connection', 'none', 0, null],
];
