import { CLIENT_ANALYTICS_ROLLUP_BUCKET_MS, ClientAnalyticsRollup, clientRollupBucketStart } from '@betterdb/shared';
import { foldGroupsIntoRollups, mergeRollupsIntoStats } from '../client-rollup-math';
import { foldClientAnalyticsStats } from '../../storage/adapters/client-analytics-stats';
import {
  buildRawFixture,
  groupsFromRaw,
  normalizeStats,
  referenceStats,
  rollupsByBucket,
} from './client-rollup-fixture';

const NOW = 1_800_000_000_000;

function foldAll(raw: ReturnType<typeof buildRawFixture>, connectionId: string): ClientAnalyticsRollup[] {
  return foldGroupsIntoRollups(connectionId, groupsFromRaw(raw, connectionId), new Map(), NOW);
}

function canonical(rows: ClientAnalyticsRollup[]): ClientAnalyticsRollup[] {
  return [...rows]
    .sort((a, b) => a.bucketStart - b.bucketStart || a.connectionId.localeCompare(b.connectionId))
    .map((r) => ({ ...r, ips: [...r.ips].sort() }));
}

describe('client rollup math', () => {
  const raw = buildRawFixture();
  const rawA = raw.filter((r) => r.connectionId === 'conn-a');

  it('fold + merge equals the naive reference over raw rows', () => {
    const rows = foldAll(raw, 'conn-a');
    expect(rows.length).toBeGreaterThan(3);
    expect(normalizeStats(mergeRollupsIntoStats(rows))).toEqual(normalizeStats(referenceStats(rawA)));
  });

  it('exercises empty names and users', () => {
    expect(rawA.some((r) => r.name === '')).toBe(true);
    expect(rawA.some((r) => r.user === '')).toBe(true);
    const stats = mergeRollupsIntoStats(foldAll(raw, 'conn-a'));
    expect(stats.connectionsByName['']).toBeUndefined();
    expect(stats.connectionsByUser['']).toBeUndefined();
  });

  it('folding in two halves equals folding once', () => {
    const once = foldAll(raw, 'conn-a');
    const times = [...new Set(rawA.map((r) => r.capturedAt))].sort((a, b) => a - b);
    // Split mid-bucket so the second call has to resume an existing row.
    const split = times.find((t) => t % CLIENT_ANALYTICS_ROLLUP_BUCKET_MS > 120_000 && t > times[10]) as number;
    const first = foldGroupsIntoRollups('conn-a', groupsFromRaw(raw, 'conn-a', -Infinity, split), new Map(), NOW);
    const second = foldGroupsIntoRollups(
      'conn-a',
      groupsFromRaw(raw, 'conn-a', split),
      rollupsByBucket(first),
      NOW,
    );
    const merged = rollupsByBucket(first);
    for (const r of second) merged.set(r.bucketStart, r);
    expect(canonical([...merged.values()])).toEqual(canonical(once));
  });

  it('does not mutate the existing rows it resumes from', () => {
    const first = foldAll(raw.filter((r) => r.capturedAt < rawA[0].capturedAt + 120_000), 'conn-a');
    const snapshot = JSON.stringify(first);
    foldGroupsIntoRollups('conn-a', groupsFromRaw(raw, 'conn-a'), rollupsByBucket(first), NOW);
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it('re-folding already-folded batches is a no-op', () => {
    const once = foldAll(raw, 'conn-a');
    const again = foldGroupsIntoRollups('conn-a', groupsFromRaw(raw, 'conn-a'), rollupsByBucket(once), NOW + 1);
    expect(again).toEqual([]);
  });

  it('merge over a bucket-aligned sub-range equals the reference over that range', () => {
    const rows = foldAll(raw, 'conn-a');
    const sub = rows.slice(1, 4);
    const from = sub[0].bucketStart;
    const to = sub[sub.length - 1].bucketStart + CLIENT_ANALYTICS_ROLLUP_BUCKET_MS;
    const rawSub = rawA.filter((r) => r.capturedAt >= from && r.capturedAt < to);
    expect(normalizeStats(mergeRollupsIntoStats(sub))).toEqual(normalizeStats(referenceStats(rawSub)));
  });

  it('merges several connections', () => {
    const rows = [...foldAll(raw, 'conn-a'), ...foldAll(raw, 'conn-b')];
    expect(normalizeStats(mergeRollupsIntoStats(rows))).toEqual(normalizeStats(referenceStats(raw)));
  });

  it('leaves connections that stopped reporting out of current, but keeps them in peaks and uniques', () => {
    const live = clientRollupBucketStart(NOW) + 60_000;
    const stale = live - 20 * 60 * 60_000;
    const rows = [
      ...foldGroupsIntoRollups(
        'live',
        [
          { capturedAt: live, name: 'api', user: 'app', ip: '10.0.0.1', count: 2, ageSum: 20 },
          { capturedAt: live, name: 'shared', user: 'default', ip: '10.0.0.2', count: 1, ageSum: 5 },
        ],
        new Map(),
        NOW,
      ),
      ...foldGroupsIntoRollups(
        'gone',
        [
          { capturedAt: stale, name: 'cron', user: 'ops', ip: '10.0.0.9', count: 5, ageSum: 50 },
          { capturedAt: stale, name: 'shared', user: 'default', ip: '10.0.0.8', count: 4, ageSum: 40 },
        ],
        new Map(),
        NOW,
      ),
    ];
    const stats = mergeRollupsIntoStats(rows);
    expect(stats.currentConnections).toBe(3);
    expect(stats.connectionsByName.api).toMatchObject({ current: 2, peak: 2 });
    expect(stats.connectionsByName.shared).toMatchObject({ current: 1, peak: 4 });
    expect(stats.connectionsByName.cron).toEqual({ current: 0, peak: 5, avgAge: 10 });
    expect(stats.connectionsByUser).toEqual({
      app: { current: 2, peak: 2 },
      default: { current: 1, peak: 4 },
      ops: { current: 0, peak: 5 },
    });
    expect(stats.connectionsByUserAndName['ops:cron']).toMatchObject({ current: 0, peak: 5 });
    expect(stats.peakConnections).toBe(9);
    expect(stats.peakTimestamp).toBe(stale);
    expect(stats.uniqueClientNames).toBe(3);
    expect(stats.uniqueUsers).toBe(3);
    expect(stats.uniqueIps).toBe(4);
    expect(stats.timeRange).toEqual({ earliest: stale, latest: live });

    // Within one bucket of the newest batch overall, both still count.
    const recent = foldGroupsIntoRollups(
      'gone',
      [{ capturedAt: live - CLIENT_ANALYTICS_ROLLUP_BUCKET_MS, name: 'cron', user: 'ops', ip: '10.0.0.9', count: 5, ageSum: 50 }],
      new Map(),
      NOW,
    );
    const both = mergeRollupsIntoStats([...rows.filter((r) => r.connectionId === 'live'), ...recent]);
    expect(both.currentConnections).toBe(8);
    expect(both.connectionsByName.cron.current).toBe(5);

    // A single stale connection on its own still reports its newest batch.
    expect(mergeRollupsIntoStats(rows.filter((r) => r.connectionId === 'gone')).currentConnections).toBe(9);
  });

  it('keeps a name seen earlier in the range with current 0', () => {
    const t0 = clientRollupBucketStart(NOW) - 10 * CLIENT_ANALYTICS_ROLLUP_BUCKET_MS;
    const rows = foldGroupsIntoRollups(
      'c',
      [
        { capturedAt: t0, name: 'gone', user: 'u', ip: '1.1.1.1', count: 2, ageSum: 10 },
        { capturedAt: t0 + CLIENT_ANALYTICS_ROLLUP_BUCKET_MS, name: 'here', user: 'u', ip: '1.1.1.1', count: 1, ageSum: 3 },
      ],
      new Map(),
      NOW,
    );
    const stats = mergeRollupsIntoStats(rows);
    expect(stats.connectionsByName.gone).toEqual({ current: 0, peak: 2, avgAge: 5 });
    expect(stats.connectionsByName.here).toEqual({ current: 1, peak: 1, avgAge: 3 });
    expect(stats.currentConnections).toBe(1);
    expect(stats.peakConnections).toBe(2);
    expect(stats.peakTimestamp).toBe(t0);
  });

  it('stores user and name on each pair, so a user containing ":" survives the merge like the raw path', () => {
    const t0 = clientRollupBucketStart(NOW) - 10 * CLIENT_ANALYTICS_ROLLUP_BUCKET_MS;
    const groups = [
      { capturedAt: t0, name: 'api', user: 'svc:ro', ip: '1.1.1.1', count: 2, ageSum: 10 },
      { capturedAt: t0, name: 'w:1', user: 'app', ip: '1.1.1.2', count: 1, ageSum: 4 },
      { capturedAt: t0 + CLIENT_ANALYTICS_ROLLUP_BUCKET_MS, name: 'api', user: 'svc:ro', ip: '1.1.1.1', count: 3, ageSum: 9 },
    ];
    const rows = foldGroupsIntoRollups('c', groups, new Map(), NOW);
    expect(rows[0].byUserAndName['svc:ro:api']).toEqual({ user: 'svc:ro', name: 'api', last: 2, peak: 2, ageSum: 10, rows: 2 });
    expect(rows[0].byUserAndName['app:w:1']).toMatchObject({ user: 'app', name: 'w:1' });

    const merged = mergeRollupsIntoStats(rows);
    expect(merged.connectionsByUserAndName['svc:ro:api']).toEqual({ user: 'svc:ro', name: 'api', current: 3, peak: 3, avgAge: 19 / 5 });
    expect(merged.connectionsByUserAndName['app:w:1']).toEqual({ user: 'app', name: 'w:1', current: 0, peak: 1, avgAge: 4 });

    const rawPath = foldClientAnalyticsStats(groups, 2);
    expect(merged.connectionsByUserAndName).toEqual(rawPath.connectionsByUserAndName);
    expect(normalizeStats(merged)).toEqual(normalizeStats(rawPath));
  });

  it('returns empty stats for no rows', () => {
    expect(mergeRollupsIntoStats([])).toEqual({
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
    });
  });
});
