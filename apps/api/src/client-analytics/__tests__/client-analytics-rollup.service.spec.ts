import { ConfigService } from '@nestjs/config';
import { CLIENT_ANALYTICS_ROLLUP_BUCKET_MS, ClientAnalyticsRollup, clientRollupBucketStart } from '@betterdb/shared';
import {
  AGGREGATE_INTERVAL_MS,
  BACKFILL_CHUNK_MS,
  BACKFILL_CHUNKS_PER_RUN,
  ClientAnalyticsRollupService,
  ClientAnalyticsRollupTuning,
} from '../client-analytics-rollup.service';
import { foldGroupsIntoRollups, mergeRollupsIntoStats } from '../client-rollup-math';
import { ConnectionRegistry } from '../../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import { StoragePort } from '../../common/interfaces/storage-port.interface';
import { SettingsService } from '../../settings/settings.service';
import { buildRawFixture, groupsFromRaw, normalizeStats, RawClientRow, referenceStats } from './client-rollup-fixture';

const HOUR = 60 * 60_000;
const BUCKET = CLIENT_ANALYTICS_ROLLUP_BUCKET_MS;

/** In-memory StoragePort fake over raw rows, implementing only what the aggregator uses. */
function createFakeStorage(raw: RawClientRow[], options: { indexReady?: boolean } = {}) {
  const rollups = new Map<string, ClientAnalyticsRollup>();
  let indexReady = options.indexReady ?? true;
  const key = (c: string, b: number) => `${c}|${b}`;
  const clone = (r: ClientAnalyticsRollup) => JSON.parse(JSON.stringify(r)) as ClientAnalyticsRollup;
  const storage = {
    getClientSnapshotBounds: jest.fn(async (connectionId: string) => {
      const ts = raw.filter((r) => r.connectionId === connectionId).map((r) => r.capturedAt);
      return ts.length ? { earliest: Math.min(...ts), latest: Math.max(...ts) } : null;
    }),
    getClientSnapshotNextCapturedAt: jest.fn(async (connectionId: string, afterExclusive: number) => {
      const ts = raw.filter((r) => r.connectionId === connectionId && r.capturedAt > afterExclusive).map((r) => r.capturedAt);
      return ts.length ? Math.min(...ts) : null;
    }),
    getClientSnapshotGroups: jest.fn(async (connectionId: string, startExclusive: number, endInclusive: number) =>
      groupsFromRaw(raw, connectionId, startExclusive, endInclusive),
    ),
    upsertClientAnalyticsRollups: jest.fn(async (rows: ClientAnalyticsRollup[]) => {
      for (const r of rows) rollups.set(key(r.connectionId, r.bucketStart), clone(r));
    }),
    getClientAnalyticsRollups: jest.fn(async (startBucket: number, endBucket: number, connectionId?: string) =>
      [...rollups.values()]
        .filter((r) => r.bucketStart >= startBucket && r.bucketStart <= endBucket)
        .filter((r) => !connectionId || r.connectionId === connectionId)
        .sort((a, b) => a.bucketStart - b.bucketStart || a.connectionId.localeCompare(b.connectionId))
        .map(clone),
    ),
    getClientAnalyticsRollupWatermark: jest.fn(async (connectionId: string) => {
      const rows = [...rollups.values()].filter((r) => r.connectionId === connectionId);
      return rows.length ? Math.max(...rows.map((r) => r.lastCapturedAt)) : null;
    }),
    getClientAnalyticsRollupFloor: jest.fn(async (connectionId: string) => {
      const rows = [...rollups.values()].filter((r) => r.connectionId === connectionId);
      return rows.length ? Math.min(...rows.map((r) => r.bucketStart)) : null;
    }),
    getClientAnalyticsRollupPeak: jest.fn(async (connectionId: string, sinceBucket: number) => {
      const rows = [...rollups.values()]
        .filter((r) => r.connectionId === connectionId && r.bucketStart >= sinceBucket)
        .sort((a, b) => b.peakConnections - a.peakConnections || a.peakCapturedAt - b.peakCapturedAt);
      return rows.length ? { peak: rows[0].peakConnections, capturedAt: rows[0].peakCapturedAt } : null;
    }),
    pruneOldClientAnalyticsRollups: jest.fn(async (olderThan: number, connectionId?: string) => {
      let n = 0;
      for (const [k, r] of rollups) {
        if (r.bucketStart < olderThan && (!connectionId || r.connectionId === connectionId)) {
          rollups.delete(k);
          n++;
        }
      }
      return n;
    }),
    pruneOldClientSnapshots: jest.fn(async () => 0),
    isClientSnapshotIndexReady: jest.fn(async () => indexReady),
  };
  return {
    storage,
    rollups,
    setIndexReady: (v: boolean) => {
      indexReady = v;
    },
  };
}

function createService(
  storage: unknown,
  env: Record<string, unknown> = {},
  tuning?: Partial<ClientAnalyticsRollupTuning>,
  isAvailable: jest.Mock = jest.fn(() => true),
  clientAnalyticsPollIntervalMs?: number,
) {
  const config = { get: jest.fn((k: string, fallback?: unknown) => env[k] ?? fallback) } as unknown as ConfigService;
  const settings =
    clientAnalyticsPollIntervalMs === undefined
      ? undefined
      : ({ getCachedSettings: () => ({ clientAnalyticsPollIntervalMs }) } as unknown as SettingsService);
  const service = new ClientAnalyticsRollupService(
    { list: jest.fn().mockReturnValue([]) } as unknown as ConnectionRegistry,
    storage as StoragePort,
    config,
    { isAvailable } as unknown as RuntimeCapabilityTracker,
    tuning,
    settings,
  );
  const log = jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  const poll = (connectionId = 'conn-a') =>
    service['pollConnection']({ connectionId, connectionName: connectionId, host: 'h', port: 1, client: {} as never });
  return { service, poll, log };
}

describe('ClientAnalyticsRollupService', () => {
  // 30 batches 60s apart, ending ~30 minutes after START.
  const START = 1_700_000_123_000;
  let raw: RawClientRow[];

  beforeEach(() => {
    raw = buildRawFixture({ start: START });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the fixed cadence and chunking unless a test tuning overrides them', () => {
    const { service } = createService(createFakeStorage([]).storage);
    expect(service.config).toMatchObject({
      aggregateIntervalMs: 15_000,
      backfillChunkMs: HOUR,
      backfillChunksPerRun: 4,
      windowMs: 24 * HOUR,
      rollupRetentionMs: 90 * 24 * HOUR,
      rawRetentionMs: null,
    });
    expect([AGGREGATE_INTERVAL_MS, BACKFILL_CHUNK_MS, BACKFILL_CHUNKS_PER_RUN]).toEqual([15_000, HOUR, 4]);
    expect(service['getIntervalMs']()).toBe(15_000);

    const tuned = createService(createFakeStorage([]).storage, {}, { backfillChunkMs: BUCKET + 1, backfillChunksPerRun: 0 });
    // Chunks round up to whole buckets; at least one chunk per run.
    expect(tuned.service.config.backfillChunkMs).toBe(2 * BUCKET);
    expect(tuned.service.config.backfillChunksPerRun).toBe(1);
  });

  it('polls Sentinel connections like the snapshot writer', () => {
    const { service } = createService(createFakeStorage([]).storage);
    expect(service['pollsSentinels']()).toBe(true);
  });

  it('cold start computes latest from the lookback window', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { service, poll } = createService(fake.storage);

    expect(service.getLatestStats('conn-a')).toBeNull();
    await poll();

    const lookbackStart = clientRollupBucketStart(now - HOUR);
    const expected = raw.filter((r) => r.connectionId === 'conn-a' && r.capturedAt >= lookbackStart);
    expect(normalizeStats(service.getLatestStats('conn-a') as never)).toEqual(normalizeStats(referenceStats(expected)));
    const calls = fake.storage.getClientSnapshotGroups.mock.calls;
    expect(calls[0][1]).toBe(lookbackStart - 1);
    expect(calls[calls.length - 1][2]).toBe(now);
    for (let i = 1; i < calls.length; i++) expect(calls[i][1]).toBeLessThanOrEqual(calls[i - 1][2]);
  });

  it('picks up the first batches written after an empty cold start on the very next run', async () => {
    // Fresh install: no raw rows exist when the aggregator first runs. The
    // writer then saves batches, and the next run must fold them without
    // waiting for the cold-start chunk cap to age past the settle margin.
    const t0 = START + 40 * 60_000 + 12_000;
    jest.useFakeTimers({ now: t0 });
    const visible: RawClientRow[] = [];
    const fake = createFakeStorage(visible, { indexReady: true });
    const { service, poll } = createService(fake.storage);

    await poll();
    // The first run stores a value even before the writer's first batch: zeros.
    expect(service.getLatestStats('conn-a')?.currentConnections).toBe(0);
    expect(fake.rollups.size).toBe(0);

    for (let i = 0; i < 3; i++) {
      const capturedAt = t0 + 3_000 + i * 5_000;
      visible.push(
        { connectionId: 'conn-a', capturedAt, name: 'api', user: 'default', ip: '10.0.0.1', age: 10 },
        { connectionId: 'conn-a', capturedAt, name: 'worker', user: 'app', ip: '10.0.0.2', age: 20 },
      );
    }
    jest.setSystemTime(t0 + 15_000);
    await poll();

    expect(service.getLatestStats('conn-a')?.currentConnections).toBe(2);
    expect(fake.rollups.size).toBe(1);
    expect(service['states'].get('conn-a')?.watermark).toBe(t0 + 13_000);
  });

  it('incremental runs across two intervals produce the same rollups as one run', async () => {
    const end = START + 31 * 60_000;
    const mid = START + 13 * 60_000 + 30_000;

    jest.useFakeTimers({ now: end });
    const once = createFakeStorage(raw, { indexReady: false });
    await createService(once.storage).poll();

    // Two-step: only the first half of the raw rows exists at the first run.
    const visible: RawClientRow[] = raw.filter((r) => r.capturedAt <= mid);
    jest.setSystemTime(mid);
    const twice = createFakeStorage(visible, { indexReady: false });
    const { service, poll } = createService(twice.storage);
    await poll();
    const firstWatermark = service['states'].get('conn-a')?.watermark as number;
    visible.push(...raw.filter((r) => r.capturedAt > mid));
    jest.setSystemTime(end);
    await poll();

    const forConn = (m: Map<string, ClientAnalyticsRollup>) =>
      [...m.values()]
        .filter((r) => r.connectionId === 'conn-a')
        .map((r) => ({ ...r, ips: [...r.ips].sort(), updatedAt: 0 }))
        .sort((a, b) => a.bucketStart - b.bucketStart);
    expect(forConn(twice.rollups)).toEqual(forConn(once.rollups));
    const lastA = Math.max(...raw.filter((r) => r.connectionId === 'conn-a').map((r) => r.capturedAt));
    expect(firstWatermark).toBeLessThanOrEqual(mid);
    expect(service['states'].get('conn-a')?.watermark).toBe(lastA);
    // The second run reads strictly after the first run's watermark.
    expect(twice.storage.getClientSnapshotGroups).toHaveBeenLastCalledWith('conn-a', firstWatermark, end);
  });

  it('skips upsert and recompute when no new rows arrived, but recomputes when the window advances', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { poll } = createService(fake.storage);
    await poll();
    const upserts = fake.storage.upsertClientAnalyticsRollups.mock.calls.length;
    const reads = fake.storage.getClientAnalyticsRollups.mock.calls.length;

    // Same window-start bucket, nothing new.
    jest.setSystemTime(clientRollupBucketStart(now) + 1000 < now ? now + 1000 : now);
    await poll();
    expect(fake.storage.upsertClientAnalyticsRollups.mock.calls.length).toBe(upserts);
    expect(fake.storage.getClientAnalyticsRollups.mock.calls.length).toBe(reads);

    // Window start crosses a bucket boundary: recompute without any upsert.
    jest.setSystemTime(now + BUCKET);
    await poll();
    expect(fake.storage.upsertClientAnalyticsRollups.mock.calls.length).toBe(upserts);
    expect(fake.storage.getClientAnalyticsRollups.mock.calls.length).toBe(reads + 1);
  });

  it('backfill waits for the index, walks back in chunks, stops at the target and logs', async () => {
    // History of 12 hours, then cold start at its end.
    const histStart = clientRollupBucketStart(START) + 2 * 60_000;
    const history = buildRawFixture({ start: histStart, batches: 12 * 12, connections: ['conn-a'], seed: 7, stepMs: 5 * 60_000 });
    const lastAt = Math.max(...history.map((r) => r.capturedAt));
    const now = lastAt + 30_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(history, { indexReady: false });
    const { service, poll, log } = createService(fake.storage, {}, { backfillChunksPerRun: 2 });

    await poll();
    expect(fake.storage.getClientAnalyticsRollupFloor).not.toHaveBeenCalled();
    const lookbackFloor = clientRollupBucketStart(now - HOUR);
    expect(Math.min(...[...fake.rollups.values()].map((r) => r.bucketStart))).toBe(lookbackFloor);

    fake.setIndexReady(true);
    let runs = 0;
    while (!service['states'].get('conn-a')?.backfillDone && runs < 20) {
      await poll();
      runs++;
    }
    // 11+ hours to walk at 2 one-hour chunks per run.
    expect(runs).toBe(Math.ceil(Math.ceil((lookbackFloor - histStart) / HOUR) / 2));

    const backfillCalls = fake.storage.getClientSnapshotGroups.mock.calls.filter(([, , end]) => end < lookbackFloor);
    let expectedEnd = lookbackFloor - 1;
    for (const [, startExclusive, endInclusive] of backfillCalls) {
      expect(endInclusive).toBe(expectedEnd);
      expect(endInclusive - startExclusive).toBe(HOUR);
      expectedEnd -= HOUR;
    }
    expect(backfillCalls[backfillCalls.length - 1][1]).toBeLessThan(histStart);

    // Every raw row is now folded exactly once.
    const all = await fake.storage.getClientAnalyticsRollups(0, Number.MAX_SAFE_INTEGER, 'conn-a');
    expect(all.reduce((s, r) => s + r.rowCount, 0)).toBe(history.length);
    expect(normalizeStats(mergeRollupsIntoStats(all))).toEqual(normalizeStats(referenceStats(history)));
    // The 24h window covers the whole history, so latest reflects the backfill too.
    expect(normalizeStats(service.getLatestStats('conn-a') as never)).toEqual(normalizeStats(referenceStats(history)));

    const messages = log.mock.calls.map(([m]) => String(m));
    expect(messages.filter((m) => m.includes('backfill') && m.includes('starting'))).toHaveLength(1);
    expect(messages.filter((m) => m.includes('backfill') && m.includes('finished'))).toHaveLength(1);

    const callsBefore = fake.storage.getClientSnapshotGroups.mock.calls.length;
    await poll();
    // Done: only the incremental read happens.
    expect(fake.storage.getClientSnapshotGroups.mock.calls.length).toBe(callsBefore + 1);
  });

  it('leaves the backfill idle without raw rows until the incremental step folds something', async () => {
    const t0 = START + 40 * 60_000 + 12_000;
    jest.useFakeTimers({ now: t0 });
    const visible: RawClientRow[] = [];
    const fake = createFakeStorage(visible, { indexReady: true });
    const { service, poll } = createService(fake.storage);

    await poll();
    expect(fake.storage.getClientSnapshotBounds).toHaveBeenCalledTimes(1);
    expect(fake.storage.getClientAnalyticsRollupFloor).toHaveBeenCalledTimes(1);
    expect(fake.storage.isClientSnapshotIndexReady).toHaveBeenCalledTimes(1);
    expect(service['states'].get('conn-a')?.backfillWaitingForData).toBe(true);

    for (let i = 1; i <= 5; i++) {
      jest.setSystemTime(t0 + i * 15_000);
      await poll();
    }
    expect(fake.storage.getClientSnapshotBounds).toHaveBeenCalledTimes(1);
    expect(fake.storage.getClientAnalyticsRollupFloor).toHaveBeenCalledTimes(1);
    expect(fake.storage.isClientSnapshotIndexReady).toHaveBeenCalledTimes(1);
    expect(service['states'].get('conn-a')?.backfillDone).toBe(false);

    // Rows appear: the next run folds them and re-checks the backfill once.
    const capturedAt = t0 + 5 * 15_000 + 3_000;
    visible.push({ connectionId: 'conn-a', capturedAt, name: 'api', user: 'default', ip: '10.0.0.1', age: 10 });
    jest.setSystemTime(t0 + 6 * 15_000);
    await poll();
    expect(fake.storage.getClientSnapshotBounds).toHaveBeenCalledTimes(2);
    expect(fake.storage.getClientAnalyticsRollupFloor).toHaveBeenCalledTimes(2);
    const state = service['states'].get('conn-a');
    expect(state?.backfillWaitingForData).toBe(false);
    // The only rows are already covered by the rollups: nothing older to fold.
    expect(state?.backfillDone).toBe(true);
  });

  it('queries index readiness until it is true, then never again in the process', async () => {
    const histStart = clientRollupBucketStart(START) + 2 * 60_000;
    const history = buildRawFixture({ start: histStart, batches: 12 * 12, connections: ['conn-a', 'conn-b'], seed: 5, stepMs: 5 * 60_000 });
    const now = Math.max(...history.map((r) => r.capturedAt)) + 30_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(history, { indexReady: false });
    const { service, poll } = createService(fake.storage, {}, { backfillChunksPerRun: 1 });

    await poll('conn-a');
    await poll('conn-b');
    expect(fake.storage.isClientSnapshotIndexReady).toHaveBeenCalledTimes(2);

    fake.setIndexReady(true);
    await poll('conn-a');
    expect(fake.storage.isClientSnapshotIndexReady).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 4; i++) {
      await poll('conn-a');
      await poll('conn-b');
    }
    expect(fake.storage.isClientSnapshotIndexReady).toHaveBeenCalledTimes(3);
    expect(service['states'].get('conn-b')?.backfillCursor).not.toBeNull();
  });

  it('warns at most once an hour while the backfill waits for the snapshot index', async () => {
    const t0 = START + 40 * 60_000;
    jest.useFakeTimers({ now: t0 });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { service, poll } = createService(fake.storage, { CLIENT_ANALYTICS_RAW_RETENTION_DAYS: '7' });
    const warn = service['logger'].warn as unknown as jest.Mock;
    const indexWarnings = () =>
      warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('idx_client_connection_captured'));

    // Many runs across two connections within the first hour: one warning.
    for (let i = 0; i < 200; i++) {
      jest.setSystemTime(t0 + i * 15_000);
      await poll('conn-a');
      await poll('conn-b');
    }
    expect(indexWarnings()).toHaveLength(1);
    expect(indexWarnings()[0]).toMatch(/backfill and raw snapshot pruning/);
    expect(indexWarnings()[0]).toMatch(/startup logs/);
    expect(service['states'].get('conn-a')?.backfillDone).toBe(false);

    // An hour after the first warning: one more.
    jest.setSystemTime(t0 + HOUR);
    await poll('conn-a');
    await poll('conn-b');
    expect(indexWarnings()).toHaveLength(2);

    // Index ready: no further warnings.
    fake.setIndexReady(true);
    jest.setSystemTime(t0 + 3 * HOUR);
    await poll('conn-a');
    expect(indexWarnings()).toHaveLength(2);
  });

  describe('catch-up after downtime', () => {
    const DAY = 24 * HOUR;
    const SETTLE = 5 * 60_000;
    const watermark = clientRollupBucketStart(START) + 2 * 60_000;
    // Exactly 72 one-hour chunks between the persisted watermark and now.
    const now = watermark + 3 * DAY;
    const batch = (capturedAt: number): RawClientRow[] => [
      { connectionId: 'conn-a', capturedAt, name: 'api', user: 'default', ip: '10.0.0.1', age: 5 },
      { connectionId: 'conn-a', capturedAt, name: 'worker', user: 'app', ip: '10.0.0.2', age: 9 },
    ];

    /** Raw rows plus rollups already folded up to the watermark, as a restart finds them. */
    async function restarted(fresh: RawClientRow[]) {
      jest.useFakeTimers({ now });
      const old = batch(watermark);
      const fake = createFakeStorage([...old, ...fresh], { indexReady: false });
      await fake.storage.upsertClientAnalyticsRollups(
        foldGroupsIntoRollups('conn-a', groupsFromRaw(old, 'conn-a'), new Map(), now),
      );
      return { fake, ...createService(fake.storage) };
    }

    it('jumps over a 72h gap and folds the newest rows in the first run', async () => {
      // New rows only in the last hour: settled ones and one inside the settle margin.
      const fresh = [...batch(now - 50 * 60_000), ...batch(now - 20 * 60_000), ...batch(now - 60_000)];
      const { fake, service, poll } = await restarted(fresh);

      await poll();
      const calls = fake.storage.getClientSnapshotGroups.mock.calls;
      // One empty settled chunk, one probe, then the chunk starting at the next batch.
      // Walking the gap chunk by chunk took 72 reads over 18 runs.
      expect(calls).toEqual([
        ['conn-a', watermark, watermark + HOUR],
        ['conn-a', now - 50 * 60_000 - 1, now],
      ]);
      expect(fake.storage.getClientSnapshotNextCapturedAt).toHaveBeenCalledTimes(1);
      expect(fake.storage.getClientSnapshotNextCapturedAt).toHaveBeenCalledWith('conn-a', watermark + HOUR);
      for (const [, startExclusive, endInclusive] of calls) {
        expect(endInclusive - startExclusive).toBeLessThanOrEqual(HOUR + SETTLE);
      }
      const state = service['states'].get('conn-a');
      expect(state?.watermark).toBe(now - 60_000);
      const latest = service.getLatestStats('conn-a');
      expect(normalizeStats(latest as never)).toEqual(
        normalizeStats({ ...referenceStats(fresh), peakConnections: 2, peakTimestamp: watermark }),
      );
      expect(latest?.currentConnections).toBe(2);
    });

    it('lands the cursor at the settle edge when the next batch is still inside the settle margin', async () => {
      const fresh = batch(now - 2 * 60_000);
      const { fake, service, poll } = await restarted(fresh);

      await poll();
      // The jump never passes the settle edge: the newest chunk (edge to now)
      // re-reads anything the writer may still be committing.
      expect(fake.storage.getClientSnapshotGroups.mock.calls).toEqual([
        ['conn-a', watermark, watermark + HOUR],
        ['conn-a', now - SETTLE, now],
      ]);
      expect(service['states'].get('conn-a')?.watermark).toBe(now - 2 * 60_000);
      expect(service.getLatestStats('conn-a')?.currentConnections).toBe(2);
    });

    it('probes once and stops when nothing newer exists, then keeps reading only the newest chunk', async () => {
      const { fake, service, poll } = await restarted([]);

      await poll();
      expect(fake.storage.getClientSnapshotGroups.mock.calls).toEqual([['conn-a', watermark, watermark + HOUR]]);
      expect(fake.storage.getClientSnapshotNextCapturedAt).toHaveBeenCalledTimes(1);
      const state = service['states'].get('conn-a');
      expect(state?.watermark).toBe(watermark);
      expect(state?.scanCursor).toBe(now - SETTLE);
      // The only rollup is 72h old, outside the 24h window: zero counts, but
      // the headline peak still covers the rollup retention.
      const emptyWindow = {
        currentConnections: 0,
        uniqueClientNames: 0,
        connectionsByName: {},
        timeRange: null,
        peakConnections: 2,
        peakTimestamp: watermark,
      };
      expect(service.getLatestStats('conn-a')).toMatchObject(emptyWindow);

      for (let i = 1; i <= 4; i++) {
        jest.setSystemTime(now + i * 15_000);
        const before = fake.storage.getClientSnapshotGroups.mock.calls.length;
        await poll();
        const calls = fake.storage.getClientSnapshotGroups.mock.calls.slice(before);
        expect(calls).toEqual([['conn-a', now - SETTLE, now + i * 15_000]]);
        expect(state?.scanCursor).toBe(now - SETTLE);
      }
      // The newest chunk is not settled, so it is never probed.
      expect(fake.storage.getClientSnapshotNextCapturedAt).toHaveBeenCalledTimes(1);
      expect(service.getLatestStats('conn-a')).toMatchObject(emptyWindow);
    });
  });

  it('stores zero counts, keeping the retention peak, when a later recompute finds an empty window', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { service, poll } = createService(fake.storage);
    await poll();
    const first = service.getLatestStats('conn-a');
    expect(first?.currentConnections).toBeGreaterThan(0);
    const peakReads = fake.storage.getClientAnalyticsRollupPeak.mock.calls.length;

    // Two days later the window holds no rollups: the recompute stores zeros.
    jest.setSystemTime(now + 48 * HOUR);
    const reads = fake.storage.getClientAnalyticsRollups.mock.calls.length;
    await poll();
    expect(fake.storage.getClientAnalyticsRollups.mock.calls.length).toBeGreaterThan(reads);
    expect(service['states'].get('conn-a')?.lastWindowStartBucket).toBe(clientRollupBucketStart(now + 24 * HOUR));
    const emptied = service.getLatestStats('conn-a');
    expect(emptied).not.toBe(first);
    expect(emptied).toEqual({
      ...mergeRollupsIntoStats([]),
      // The rollups are older than the window but inside the 90-day retention.
      peakConnections: first?.peakConnections,
      peakTimestamp: first?.peakTimestamp,
    });
    expect(fake.storage.getClientAnalyticsRollupPeak.mock.calls.length).toBe(peakReads + 1);

    // The same empty window is not re-read on every run.
    const after = fake.storage.getClientAnalyticsRollups.mock.calls.length;
    jest.setSystemTime(now + 48 * HOUR + 15_000);
    await poll();
    expect(fake.storage.getClientAnalyticsRollups.mock.calls.length).toBe(after);
  });

  it('memoises the all-connection window stats for one aggregate interval', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { service, poll } = createService(fake.storage);
    await poll('conn-a');
    await poll('conn-b');
    fake.storage.getClientAnalyticsRollups.mockClear();

    const first = await service.getLatestStatsAllConnections();
    jest.setSystemTime(now + AGGREGATE_INTERVAL_MS - 1);
    const second = await service.getLatestStatsAllConnections();
    expect(second).toBe(first);
    expect(fake.storage.getClientAnalyticsRollups).toHaveBeenCalledTimes(1);
    expect(fake.storage.getClientAnalyticsRollups).toHaveBeenCalledWith(
      clientRollupBucketStart(now - 24 * HOUR),
      clientRollupBucketStart(now),
      undefined,
    );
    expect(normalizeStats(first)).toEqual(normalizeStats(referenceStats(raw)));

    jest.setSystemTime(now + AGGREGATE_INTERVAL_MS);
    await service.getLatestStatsAllConnections();
    expect(fake.storage.getClientAnalyticsRollups).toHaveBeenCalledTimes(2);
  });

  it('does not memoise a failed all-connection read', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { service } = createService(fake.storage);
    fake.storage.getClientAnalyticsRollups.mockRejectedValueOnce(new Error('db down'));
    await expect(service.getLatestStatsAllConnections()).rejects.toThrow('db down');
    await expect(service.getLatestStatsAllConnections()).resolves.toBeDefined();
    expect(fake.storage.getClientAnalyticsRollups).toHaveBeenCalledTimes(2);
  });

  it('stops the backfill at the rollup retention horizon', async () => {
    const histStart = clientRollupBucketStart(START);
    const history = buildRawFixture({ start: histStart, batches: 4 * 24 * 4, connections: ['conn-a'], seed: 3, stepMs: 15 * 60_000 });
    const now = Math.max(...history.map((r) => r.capturedAt)) + 1000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(history);
    const { service, poll } = createService(
      fake.storage,
      { CLIENT_ANALYTICS_ROLLUP_RETENTION_DAYS: 1 },
      { backfillChunksPerRun: 50 },
    );
    for (let i = 0; i < 3; i++) await poll();
    expect(service['states'].get('conn-a')?.backfillDone).toBe(true);
    const lowest = Math.min(...fake.storage.getClientSnapshotGroups.mock.calls.map(([, s]) => s as number));
    expect(lowest).toBeGreaterThanOrEqual(now - 24 * HOUR - HOUR - 1);
  });

  it('prunes rollups hourly and raw snapshots only when raw retention is configured', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { poll } = createService(fake.storage);
    await poll();
    expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledWith(
      clientRollupBucketStart(now - 90 * 24 * HOUR),
      'conn-a',
    );
    expect(fake.storage.pruneOldClientSnapshots).not.toHaveBeenCalled();
    await poll();
    expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(1);
    jest.setSystemTime(now + HOUR);
    await poll();
    expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(2);

    const withRaw = createFakeStorage(raw, { indexReady: true });
    const rawService = createService(withRaw.storage, { CLIENT_ANALYTICS_RAW_RETENTION_DAYS: '7' });
    await rawService.poll();
    expect(rawService.service['states'].get('conn-a')?.backfillDone).toBe(true);
    expect(withRaw.storage.pruneOldClientSnapshots).toHaveBeenCalledWith(now + HOUR - 7 * 24 * HOUR, 'conn-a');
  });

  it('never prunes raw snapshots before the backfill has folded them, but still prunes rollups', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    // Index not ready: the backfill cannot start, so older raw history is unfolded.
    const fake = createFakeStorage(raw, { indexReady: false });
    const { service, poll } = createService(fake.storage, { CLIENT_ANALYTICS_RAW_RETENTION_DAYS: '7' });
    await poll();
    expect(service['states'].get('conn-a')?.backfillDone).toBe(false);
    expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(1);
    expect(fake.storage.pruneOldClientSnapshots).not.toHaveBeenCalled();

    // Backfill completes; the next retention pass prunes raw rows too.
    fake.setIndexReady(true);
    jest.setSystemTime(now + HOUR);
    await poll();
    expect(service['states'].get('conn-a')?.backfillDone).toBe(true);
    expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(2);
    expect(fake.storage.pruneOldClientSnapshots).toHaveBeenCalledWith(now + HOUR - 7 * 24 * HOUR, 'conn-a');
  });

  describe('without the CLIENT LIST capability', () => {
    const rawReads = ['getClientSnapshotGroups', 'getClientSnapshotBounds', 'getClientSnapshotNextCapturedAt'] as const;

    it('skips the fold and backfill after the capability flips off, but keeps the window and retention running', async () => {
      const now = START + 40 * 60_000;
      jest.useFakeTimers({ now });
      const fake = createFakeStorage(raw, { indexReady: true });
      const isAvailable = jest.fn((_id: string, _cap: string) => true);
      const { service, poll } = createService(fake.storage, {}, undefined, isAvailable);
      await poll();
      const first = service.getLatestStats('conn-a');
      expect(first?.currentConnections).toBeGreaterThan(0);
      expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(1);

      isAvailable.mockImplementation((_id: string, cap: string) => cap !== 'canClientList');
      for (const name of rawReads) fake.storage[name].mockClear();
      fake.storage.getClientAnalyticsRollupWatermark.mockClear();
      fake.storage.getClientAnalyticsRollupFloor.mockClear();
      fake.storage.isClientSnapshotIndexReady.mockClear();
      fake.storage.upsertClientAnalyticsRollups.mockClear();

      // Same window start bucket: nothing to recompute.
      jest.setSystemTime(now + 15_000);
      const reads = fake.storage.getClientAnalyticsRollups.mock.calls.length;
      await poll();
      expect(fake.storage.getClientAnalyticsRollups.mock.calls.length).toBe(reads);
      expect(service.getLatestStats('conn-a')).toBe(first);

      // The window start advances: the recompute reads rollups (and only rollups).
      jest.setSystemTime(now + BUCKET);
      await poll();
      expect(fake.storage.getClientAnalyticsRollups.mock.calls.length).toBe(reads + 1);
      expect(fake.storage.getClientAnalyticsRollups).toHaveBeenLastCalledWith(
        clientRollupBucketStart(now + BUCKET - 24 * HOUR),
        clientRollupBucketStart(now + BUCKET),
        'conn-a',
      );
      expect(normalizeStats(service.getLatestStats('conn-a') as never)).toEqual(normalizeStats(first as never));
      expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(1);

      // An hour later: retention runs on its hourly cadence.
      jest.setSystemTime(now + HOUR);
      await poll();
      expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(2);
      expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenLastCalledWith(
        clientRollupBucketStart(now + HOUR - 90 * 24 * HOUR),
        'conn-a',
      );

      // Four days later the window is empty: latest reports zeros, keeping the retention peak.
      jest.setSystemTime(now + 4 * 24 * HOUR);
      await poll();
      expect(service.getLatestStats('conn-a')).toEqual({
        ...mergeRollupsIntoStats([]),
        peakConnections: first?.peakConnections,
        peakTimestamp: first?.peakTimestamp,
      });
      expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(3);

      for (const name of rawReads) expect(fake.storage[name]).not.toHaveBeenCalled();
      expect(fake.storage.getClientAnalyticsRollupWatermark).not.toHaveBeenCalled();
      expect(fake.storage.getClientAnalyticsRollupFloor).not.toHaveBeenCalled();
      expect(fake.storage.isClientSnapshotIndexReady).not.toHaveBeenCalled();
      expect(fake.storage.upsertClientAnalyticsRollups).not.toHaveBeenCalled();
    });

    it('never initialises cold-start state while the capability is off, then initialises once it returns', async () => {
      const now = START + 40 * 60_000;
      jest.useFakeTimers({ now });
      const fake = createFakeStorage(raw);
      const isAvailable = jest.fn((_id: string, cap: string) => cap !== 'canClientList');
      const { service, poll } = createService(fake.storage, {}, undefined, isAvailable);
      await poll();
      expect(isAvailable).toHaveBeenCalledWith('conn-a', 'canClientList');
      for (const name of rawReads) expect(fake.storage[name]).not.toHaveBeenCalled();
      expect(fake.storage.getClientAnalyticsRollupWatermark).not.toHaveBeenCalled();
      expect(fake.storage.upsertClientAnalyticsRollups).not.toHaveBeenCalled();
      // Nothing was ever folded: the window is empty, so zeros; retention still runs.
      expect(service.getLatestStats('conn-a')).toEqual(mergeRollupsIntoStats([]));
      expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(1);
      expect(service['states'].get('conn-a')?.watermark).toBeNull();

      // Capability restored: the state is initialised from storage and the connection folds again.
      isAvailable.mockReturnValue(true);
      const passive = service['states'].get('conn-a');
      await poll();
      expect(fake.storage.getClientAnalyticsRollupWatermark).toHaveBeenCalledTimes(1);
      expect(service['states'].get('conn-a')).toBe(passive);
      const lookbackStart = clientRollupBucketStart(now - HOUR);
      const expected = raw.filter((r) => r.connectionId === 'conn-a' && r.capturedAt >= lookbackStart);
      expect(normalizeStats(service.getLatestStats('conn-a') as never)).toEqual(normalizeStats(referenceStats(expected)));
      // Retention keeps its hourly clock across the upgrade.
      expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(1);
    });
  });

  it('installs no state when the connection is removed while the watermark read is pending', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw);
    let release: (v: number | null) => void = () => undefined;
    fake.storage.getClientAnalyticsRollupWatermark.mockImplementationOnce(
      () => new Promise<number | null>((resolve) => (release = resolve)),
    );
    const { service, poll } = createService(fake.storage);
    const run = poll();
    await Promise.resolve();
    expect(fake.storage.getClientAnalyticsRollupWatermark).toHaveBeenCalledTimes(1);
    service['onConnectionRemoved']('conn-a');
    release(null);
    await run;

    expect(service['states'].has('conn-a')).toBe(false);
    expect(service.getLatestStats('conn-a')).toBeNull();
    expect(fake.storage.getClientSnapshotGroups).not.toHaveBeenCalled();
    expect(fake.storage.getClientAnalyticsRollups).not.toHaveBeenCalled();
    expect(fake.storage.upsertClientAnalyticsRollups).not.toHaveBeenCalled();
    expect(fake.storage.pruneOldClientAnalyticsRollups).not.toHaveBeenCalled();

    // A connection that comes back later initialises normally.
    await poll();
    expect(service.getLatestStats('conn-a')).not.toBeNull();
  });

  it('bounds every raw read by the chunk size, including catch-up after downtime', async () => {
    // Persisted watermark 10 hours behind now: catch-up must be chunked.
    const history = buildRawFixture({ start: START, batches: 11 * 12, connections: ['conn-a'], seed: 5, stepMs: 5 * 60_000 });
    const now = Math.max(...history.map((r) => r.capturedAt)) + 1000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(history, { indexReady: false });
    const early = history.filter((r) => r.capturedAt < START + HOUR);
    const seeded = foldGroupsIntoRollups('conn-a', groupsFromRaw(early, 'conn-a'), new Map(), now);
    await fake.storage.upsertClientAnalyticsRollups(seeded);

    const { service, poll } = createService(fake.storage, {}, { backfillChunksPerRun: 3 });
    for (let i = 0; i < 6; i++) await poll();
    // The newest chunk may run on to `now` (at most one settle margin past
    // the chunk size) so rows written since the cap are never left behind.
    for (const [, startExclusive, endInclusive] of fake.storage.getClientSnapshotGroups.mock.calls) {
      expect(endInclusive - startExclusive).toBeLessThanOrEqual(HOUR + 5 * 60_000);
    }
    const all = await fake.storage.getClientAnalyticsRollups(0, Number.MAX_SAFE_INTEGER, 'conn-a');
    expect(all.reduce((s, r) => s + r.rowCount, 0)).toBe(history.length);
    expect(service['states'].get('conn-a')?.watermark).toBe(Math.max(...history.map((r) => r.capturedAt)));
  });

  describe('headline peak over the rollup retention', () => {
    const DAY = 24 * HOUR;
    const now = clientRollupBucketStart(START) + 10 * DAY + 2 * 60_000;
    const oldAt = now - 3 * DAY;
    const rowsAt = (capturedAt: number, name: string, n: number): RawClientRow[] =>
      Array.from({ length: n }, (_, i) => ({
        connectionId: 'conn-a',
        capturedAt,
        name,
        user: 'default',
        ip: `10.0.0.${i + 1}`,
        age: 5,
      }));
    // Three days ago: a burst of 12 'api' clients. In the window: at most 3.
    const history = [
      ...rowsAt(oldAt, 'api', 12),
      ...rowsAt(now - 2 * HOUR, 'api', 2),
      ...rowsAt(now - HOUR, 'api', 3),
      ...rowsAt(now - 60_000, 'api', 1),
    ];

    async function seeded(env: Record<string, unknown> = {}) {
      jest.useFakeTimers({ now });
      const fake = createFakeStorage(history, { indexReady: false });
      // Everything is already folded, so the run only recomputes latest.
      await fake.storage.upsertClientAnalyticsRollups(
        foldGroupsIntoRollups('conn-a', groupsFromRaw(history, 'conn-a'), new Map(), now),
      );
      const { service, poll } = createService(fake.storage, env);
      await poll();
      return { fake, service };
    }

    it('reports a peak older than the window but inside retention, keeping per-group peaks window-scoped', async () => {
      const { fake, service } = await seeded();
      const latest = service.getLatestStats('conn-a');
      expect(latest?.peakConnections).toBe(12);
      expect(latest?.peakTimestamp).toBe(oldAt);
      expect(fake.storage.getClientAnalyticsRollupPeak).toHaveBeenCalledWith(
        'conn-a',
        clientRollupBucketStart(now - 90 * DAY),
      );
      // Per-name and per-user peaks, and unique counts, cover the 24h window only.
      expect(latest?.connectionsByName.api.peak).toBe(3);
      expect(latest?.connectionsByUser.default.peak).toBe(3);
      expect(latest?.uniqueIps).toBe(3);
      expect(latest?.currentConnections).toBe(1);

      // Explicit ranges keep the peak within the range.
      const ranged = await service.getStatsForRange(now - 24 * HOUR, now, 'conn-a');
      expect(ranged.peakConnections).toBe(3);
      expect(ranged.peakTimestamp).toBe(now - HOUR);
    });

    it('ignores buckets older than the rollup retention', async () => {
      const { service } = await seeded({ CLIENT_ANALYTICS_ROLLUP_RETENTION_DAYS: 2 });
      expect(service.getLatestStats('conn-a')?.peakConnections).toBe(3);
      expect(service.getLatestStats('conn-a')?.peakTimestamp).toBe(now - HOUR);
    });

    it('resolves an equal peak inside and outside the window to the earliest capture', async () => {
      // A batch of 3 at 30h back ties the in-window peak of 3 at 1h back; the
      // retention read wins the tie because it is earlier.
      const tied = [...history, ...rowsAt(now - 30 * HOUR, 'api', 3)];
      jest.useFakeTimers({ now });
      const fake = createFakeStorage(tied, { indexReady: false });
      await fake.storage.upsertClientAnalyticsRollups(
        foldGroupsIntoRollups('conn-a', groupsFromRaw(tied, 'conn-a'), new Map(), now),
      );
      const { service, poll } = createService(fake.storage, { CLIENT_ANALYTICS_ROLLUP_RETENTION_DAYS: 2 });
      await poll();
      expect(service.getLatestStats('conn-a')?.peakConnections).toBe(3);
      expect(service.getLatestStats('conn-a')?.peakTimestamp).toBe(now - 30 * HOUR);
    });

    describe('kept in state instead of re-queried', () => {
      async function setup(env: Record<string, unknown> = {}) {
        jest.useFakeTimers({ now });
        const rawRows = [...history];
        const fake = createFakeStorage(rawRows, { indexReady: false });
        await fake.storage.upsertClientAnalyticsRollups(
          foldGroupsIntoRollups('conn-a', groupsFromRaw(rawRows, 'conn-a'), new Map(), now),
        );
        const { service, poll } = createService(fake.storage, env);
        const peakReads = () => fake.storage.getClientAnalyticsRollupPeak.mock.calls.length;
        // The storage read the in-state peak must agree with (called after the counts are checked).
        const oracle = (at: number) =>
          fake.storage.getClientAnalyticsRollupPeak('conn-a', clientRollupBucketStart(at - service.config.rollupRetentionMs));
        return { fake, service, poll, rawRows, peakReads, oracle };
      }

      it('reads the peak on init and after the first prune, then not on ordinary runs', async () => {
        const { service, poll, peakReads, oracle } = await setup();
        await poll();
        // Init, then the run's (first) rollup prune.
        expect(peakReads()).toBe(2);
        expect(service['states'].get('conn-a')?.retentionPeak).toEqual({ peak: 12, capturedAt: oldAt });

        for (let i = 1; i <= 3; i++) {
          jest.setSystemTime(now + i * 15_000);
          await poll();
        }
        expect(peakReads()).toBe(2);
        const latest = service.getLatestStats('conn-a');
        const expected = await oracle(now + 45_000);
        expect([latest?.peakConnections, latest?.peakTimestamp]).toEqual([expected?.peak, expected?.capturedAt]);
      });

      it('raises the in-state peak from folded rows without querying it', async () => {
        const { service, poll, rawRows, peakReads, oracle } = await setup();
        await poll();
        const reads = peakReads();

        const burstAt = now + 10_000;
        rawRows.push(...rowsAt(burstAt, 'api', 20));
        jest.setSystemTime(now + 15_000);
        await poll();
        expect(peakReads()).toBe(reads);
        expect(service['states'].get('conn-a')?.retentionPeak).toEqual({ peak: 20, capturedAt: burstAt });
        const latest = service.getLatestStats('conn-a');
        expect(latest?.peakConnections).toBe(20);
        expect(latest?.peakTimestamp).toBe(burstAt);
        expect(await oracle(now + 15_000)).toEqual({ peak: 20, capturedAt: burstAt });
      });

      it('re-reads the peak when the horizon passes its bucket and after the next hourly prune', async () => {
        // Retention of 3 days + 30 minutes: the 12-client bucket survives the
        // first prune, leaves the horizon ~33 minutes later and is removed by
        // the prune an hour later.
        const retentionDays = (3 * DAY + 30 * 60_000) / DAY;
        const { service, poll, fake, peakReads, oracle } = await setup({
          CLIENT_ANALYTICS_ROLLUP_RETENTION_DAYS: retentionDays,
        });
        await poll();
        expect(service.getLatestStats('conn-a')?.peakConnections).toBe(12);
        const reads = peakReads();

        // The horizon passes the peak's bucket about 33 minutes in: re-read then (no prune yet).
        jest.setSystemTime(now + 40 * 60_000);
        await poll();
        expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(1);
        expect(peakReads()).toBe(reads + 1);
        const afterHorizon = service.getLatestStats('conn-a');
        const expectedAfterHorizon = await oracle(now + 40 * 60_000);
        expect(expectedAfterHorizon).toEqual({ peak: 3, capturedAt: now - HOUR });
        expect([afterHorizon?.peakConnections, afterHorizon?.peakTimestamp]).toEqual([3, now - HOUR]);

        // The next hourly prune re-reads it again.
        const beforePrune = peakReads();
        jest.setSystemTime(now + HOUR);
        await poll();
        expect(fake.storage.pruneOldClientAnalyticsRollups).toHaveBeenCalledTimes(2);
        expect(peakReads()).toBe(beforePrune + 1);
        const afterPrune = service.getLatestStats('conn-a');
        const expectedAfterPrune = await oracle(now + HOUR);
        expect([afterPrune?.peakConnections, afterPrune?.peakTimestamp]).toEqual([
          expectedAfterPrune?.peak,
          expectedAfterPrune?.capturedAt,
        ]);
      });

      it('re-reads the peak when the horizon passes its bucket between prunes', async () => {
        // A 3-day retention puts the 12-client bucket exactly at the horizon now.
        const { service, poll, peakReads, oracle } = await setup({ CLIENT_ANALYTICS_ROLLUP_RETENTION_DAYS: 3 });
        await poll();
        expect(service.getLatestStats('conn-a')?.peakConnections).toBe(12);
        const reads = peakReads();

        jest.setSystemTime(now + BUCKET);
        await poll();
        expect(peakReads()).toBe(reads + 1);
        const latest = service.getLatestStats('conn-a');
        const expected = await oracle(now + BUCKET);
        expect(expected).toEqual({ peak: 3, capturedAt: now - HOUR });
        expect([latest?.peakConnections, latest?.peakTimestamp]).toEqual([3, now - HOUR]);
      });
    });

    describe('getWindowStatsWithRetentionPeak', () => {
      async function unpolled() {
        jest.useFakeTimers({ now });
        const fake = createFakeStorage(history, { indexReady: false });
        await fake.storage.upsertClientAnalyticsRollups(
          foldGroupsIntoRollups('conn-a', groupsFromRaw(history, 'conn-a'), new Map(), now),
        );
        return { fake, ...createService(fake.storage) };
      }

      it('applies the retention peak before the first run, matching what that run then reports', async () => {
        const { service, poll, fake } = await unpolled();
        const before = await service.getWindowStatsWithRetentionPeak('conn-a');
        expect(service.getLatestStats('conn-a')).toBeNull();
        expect(before.peakConnections).toBe(12);
        expect(before.peakTimestamp).toBe(oldAt);
        expect(fake.storage.getClientAnalyticsRollupPeak).toHaveBeenCalledWith(
          'conn-a',
          clientRollupBucketStart(now - 90 * DAY),
        );
        // The range read alone would report the window-scoped peak.
        expect((await service.getStatsForRange(now - 24 * HOUR, now, 'conn-a')).peakConnections).toBe(3);

        await poll();
        expect(service.getLatestStats('conn-a')).toEqual(before);
      });

      it('uses the in-state peak once the state holds one', async () => {
        const { service, poll, fake } = await unpolled();
        await poll();
        const reads = fake.storage.getClientAnalyticsRollupPeak.mock.calls.length;
        const stats = await service.getWindowStatsWithRetentionPeak('conn-a');
        expect(fake.storage.getClientAnalyticsRollupPeak.mock.calls.length).toBe(reads);
        expect([stats.peakConnections, stats.peakTimestamp]).toEqual([12, oldAt]);
      });
    });
  });

  it('serves range queries from rollups and clears state on removal', async () => {
    const now = START + 40 * 60_000;
    jest.useFakeTimers({ now });
    const fake = createFakeStorage(raw, { indexReady: false });
    const { service, poll } = createService(fake.storage);
    await poll();
    await poll('conn-b');

    const stats = await service.getStatsForRange(START - HOUR, now);
    expect(normalizeStats(stats)).toEqual(normalizeStats(referenceStats(raw)));

    service['onConnectionRemoved']('conn-a');
    expect(service.getLatestStats('conn-a')).toBeNull();
    expect(service.getLatestStats('conn-b')).not.toBeNull();
  });

  describe('cross-connection current cutoff', () => {
    const now = clientRollupBucketStart(START) + 10 * HOUR + 30_000;
    const at = (connectionId: string, capturedAt: number): RawClientRow => ({
      connectionId,
      capturedAt,
      name: 'api',
      user: 'default',
      ip: '10.0.0.1',
      age: 5,
    });

    async function seeded(behindMs: number, pollIntervalMs?: number) {
      jest.useFakeTimers({ now });
      const rows = [at('live', now - 10_000), at('lagging', now - 10_000 - behindMs)];
      const fake = createFakeStorage(rows, { indexReady: false });
      for (const id of ['live', 'lagging']) {
        await fake.storage.upsertClientAnalyticsRollups(foldGroupsIntoRollups(id, groupsFromRaw(rows, id), new Map(), now));
      }
      return createService(fake.storage, {}, undefined, undefined, pollIntervalMs).service;
    }

    it('follows the poll interval: two intervals of 10 minutes keep a connection 15 minutes behind, not 25', async () => {
      const service = await seeded(15 * 60_000, 10 * 60_000);
      expect((await service.getStatsForRange(now - 24 * HOUR, now)).currentConnections).toBe(2);
      expect((await service.getLatestStatsAllConnections()).currentConnections).toBe(2);

      const farther = await seeded(25 * 60_000, 10 * 60_000);
      expect((await farther.getStatsForRange(now - 24 * HOUR, now)).currentConnections).toBe(1);
      expect((await farther.getLatestStatsAllConnections()).currentConnections).toBe(1);
    });

    it('stays one bucket (5 minutes) with the default poll interval or without settings', async () => {
      for (const pollIntervalMs of [60_000, undefined]) {
        const within = await seeded(5 * 60_000, pollIntervalMs);
        expect((await within.getStatsForRange(now - 24 * HOUR, now)).currentConnections).toBe(2);
        const behind = await seeded(6 * 60_000, pollIntervalMs);
        expect((await behind.getStatsForRange(now - 24 * HOUR, now)).currentConnections).toBe(1);
      }
    });
  });
});
