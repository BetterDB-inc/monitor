import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { clientAddrIp } from '../client-analytics-stats';
import { foldGroupsIntoRollups, mergeRollupsIntoStats } from '../../../client-analytics/client-rollup-math';
import { clientPairKey } from '@betterdb/shared';
import {
  BATCH_MS,
  COLLIDE_CONNECTION,
  CONNECTIONS,
  EDGE_CONNECTION,
  EDGE_IPS,
  buildCollidingPairFixture,
  buildEdgeFixture,
  PEAK_CASES,
  STATS_RANGES,
  T0,
  buildFixture,
  peakRollups,
  referenceStats,
  rollup,
  seedFixture,
  type FixtureRow,
} from './client-analytics-rollups.fixture';

const BUCKET = 300_000;

interface Harness {
  storage: StoragePort;
  cleanup: () => Promise<void>;
}

async function memoryHarness(): Promise<Harness> {
  const storage = new MemoryAdapter();
  await storage.initialize();
  return { storage, cleanup: () => storage.close() };
}

async function sqliteHarness(): Promise<Harness> {
  const path = join(tmpdir(), `client-analytics-rollups-${Date.now()}-${Math.random()}.db`);
  const storage = new SqliteAdapter({ filepath: path });
  await storage.initialize();
  return {
    storage,
    cleanup: async () => {
      await storage.close();
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(path + suffix);
        } catch {
          // already gone
        }
      }
    },
  };
}

function client(capturedAt: number, overrides: Partial<FixtureRow> = {}): FixtureRow {
  return {
    clientId: `c-${Math.random()}`,
    addr: '10.1.1.1:5000',
    name: 'api',
    user: 'default',
    db: 0,
    cmd: 'get',
    age: 10,
    idle: 0,
    flags: 'N',
    sub: 0,
    psub: 0,
    qbuf: 0,
    qbufFree: 0,
    obl: 0,
    oll: 0,
    omem: 0,
    capturedAt,
    sourceHost: 'localhost',
    sourcePort: 6379,
    connectionId: 'conn-x',
    ...overrides,
  };
}

async function save(storage: StoragePort, rows: FixtureRow[], connectionId = 'conn-x') {
  await storage.saveClientSnapshot(
    rows.map((r) => ({ ...r, id: 0 })),
    connectionId,
  );
}

describe.each([
  ['MemoryAdapter', memoryHarness],
  ['SqliteAdapter', sqliteHarness],
])('%s client analytics rollups', (_label, makeHarness) => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  describe('getClientConnections', () => {
    const since = 1_000_000;
    const until = 2_000_000;
    const rows = (overrides: Array<Partial<ReturnType<typeof client>>>) =>
      overrides.map((o) => ({ ...client(since), ...o }));
    const byClient = <T extends { clientId: string; addr: string }>(connections: T[]) =>
      [...connections].sort((x, y) => `${x.clientId} ${x.addr}`.localeCompare(`${y.clientId} ${y.addr}`));

    it('reads each connection once across captures with when it opened and was captured', async () => {
      await save(
        h.storage,
        rows([
          { clientId: 'a', name: 'api', user: 'svc', addr: '10.0.0.1:1', age: 0, capturedAt: since },
          { clientId: 'a', name: 'api', user: 'svc', addr: '10.0.0.1:1', age: 60, capturedAt: since + 60_000 },
          { clientId: 'b', name: 'api', user: 'svc', addr: '10.0.0.1:2', age: 1, capturedAt: since + 60_000 },
          { clientId: 'c', name: '', user: 'default', addr: '[::1]:6379', age: 1, capturedAt: since + 60_000 },
        ]),
      );

      expect(byClient(await h.storage.getClientConnections('conn-x', since, until))).toEqual([
        {
          clientId: 'a',
          addr: '10.0.0.1:1',
          name: 'api',
          user: 'svc',
          ip: '10.0.0.1',
          openedAt: since,
          firstCapturedAt: since,
          lastCapturedAt: since + 60_000,
        },
        {
          clientId: 'b',
          addr: '10.0.0.1:2',
          name: 'api',
          user: 'svc',
          ip: '10.0.0.1',
          openedAt: since + 59_000,
          firstCapturedAt: since + 60_000,
          lastCapturedAt: since + 60_000,
        },
        {
          clientId: 'c',
          addr: '[::1]:6379',
          name: '',
          user: 'default',
          ip: '[::1]',
          openedAt: since + 59_000,
          firstCapturedAt: since + 60_000,
          lastCapturedAt: since + 60_000,
        },
      ]);
    });

    it('skips other connections and captures outside the range', async () => {
      await save(
        h.storage,
        rows([
          { clientId: 'early', name: 'pool', age: 5, capturedAt: since - 1 },
          { clientId: 'late', name: 'later', age: 0, capturedAt: until + 1 },
        ]),
      );
      await save(h.storage, rows([{ clientId: 'x', name: 'other', age: 0 }]), 'other');

      expect(await h.storage.getClientConnections('conn-x', since, until)).toEqual([]);
    });

    it('finds early connections that a limited snapshot read drops', async () => {
      await save(
        h.storage,
        rows([
          { clientId: 'early', name: 'retrier', age: 0, capturedAt: since },
          { clientId: 'p1', name: 'pool', age: 9_999, capturedAt: since + 60_000 },
          { clientId: 'p2', name: 'pool', age: 9_999, capturedAt: since + 60_000 },
        ]),
      );

      const limited = await h.storage.getClientSnapshots({
        connectionId: 'conn-x',
        startTime: since,
        endTime: until,
        limit: 2,
      });
      expect(limited.map((r) => r.clientId)).not.toContain('early');
      expect(await h.storage.getClientConnections('conn-x', since, until)).toContainEqual(
        expect.objectContaining({ clientId: 'early', name: 'retrier', openedAt: since }),
      );
    });

    it('leaves replica and master links out', async () => {
      await save(
        h.storage,
        rows([
          { clientId: 'r', name: 'replica', flags: 'S', age: 0 },
          { clientId: 'm', name: 'master', flags: 'M', age: 0 },
          { clientId: 'n', name: 'api', flags: 'N', age: 0 },
        ]),
      );

      expect(await h.storage.getClientConnections('conn-x', since, until)).toEqual([
        expect.objectContaining({ clientId: 'n', name: 'api' }),
      ]);
    });

    it('names a client that set its name after a capture by that name', async () => {
      const storm = { addr: '10.0.0.5:4001', user: 'default' };
      await save(
        h.storage,
        rows([
          { clientId: '7', name: '', ...storm, age: 0, capturedAt: since },
          { clientId: '7', name: 'storm', ...storm, age: 60, capturedAt: since + 60_000 },
          { clientId: '7', name: 'storm', ...storm, age: 120, capturedAt: since + 120_000 },
          { clientId: '8', name: '', ...storm, addr: '10.0.0.5:4002', age: 1, capturedAt: since + 120_000 },
        ]),
      );

      expect(byClient(await h.storage.getClientConnections('conn-x', since, until))).toEqual([
        expect.objectContaining({
          clientId: '7',
          name: 'storm',
          openedAt: since,
          firstCapturedAt: since,
          lastCapturedAt: since + 120_000,
        }),
        expect.objectContaining({ clientId: '8', name: '', ip: '10.0.0.5' }),
      ]);
    });

    it('keeps a client id reused on another address apart', async () => {
      await save(
        h.storage,
        rows([
          { clientId: '5', name: 'api', addr: '10.0.0.1:1', age: 0, capturedAt: since },
          { clientId: '5', name: '', addr: '10.0.0.2:1', age: 0, capturedAt: since + 60_000 },
        ]),
      );

      expect(byClient(await h.storage.getClientConnections('conn-x', since, until))).toEqual([
        expect.objectContaining({ clientId: '5', addr: '10.0.0.1:1', name: 'api', openedAt: since }),
        expect.objectContaining({ clientId: '5', addr: '10.0.0.2:1', name: '', openedAt: since + 60_000 }),
      ]);
    });

    it("leaves the monitor's own connections out from the time they connected", async () => {
      await save(
        h.storage,
        rows([
          // The application held id 3 before the server restarted and renumbered.
          { clientId: '3', name: 'api', addr: '10.0.0.1:1', age: 0, capturedAt: since },
          // The monitor got id 3 after the restart, unnamed at first.
          { clientId: '3', name: '', addr: '10.0.0.9:1', age: 0, capturedAt: since + 60_000 },
          { clientId: '3', name: 'acme-monitor', addr: '10.0.0.9:1', age: 60, capturedAt: since + 120_000 },
          { clientId: '4', name: 'api', addr: '10.0.0.1:2', age: 0, capturedAt: since + 120_000 },
        ]),
      );
      const own = [{ id: '3', connectedAt: since + 30_000 }];

      expect(byClient(await h.storage.getClientConnections('conn-x', since, until, own))).toEqual([
        expect.objectContaining({ clientId: '3', addr: '10.0.0.1:1', name: 'api' }),
        expect.objectContaining({ clientId: '4', addr: '10.0.0.1:2', name: 'api' }),
      ]);
      const captures = await h.storage.getClientConnectionCaptures('conn-x', since, until, own);
      expect(captures.sort((x, y) => x.capturedAt - y.capturedAt)).toEqual([
        expect.objectContaining({ capturedAt: since, name: 'api', maxClientId: 3 }),
        expect.objectContaining({ capturedAt: since + 120_000, name: 'api', maxClientId: 4 }),
      ]);
    });

    it("leaves a closed own connection out up to its close and keeps the id's later holder", async () => {
      await save(
        h.storage,
        rows([
          // The monitor's previous connection, custom-named, closed at +90s.
          { clientId: '3', name: '', addr: '10.0.0.9:1', age: 0, capturedAt: since },
          { clientId: '3', name: 'acme-monitor', addr: '10.0.0.9:1', age: 60, capturedAt: since + 60_000 },
          { clientId: '3', name: 'acme-monitor', addr: '10.0.0.9:1', age: 90, capturedAt: since + 90_000 },
          // Its replacement, still open.
          { clientId: '2', name: 'acme-monitor', addr: '10.0.0.9:2', age: 0, capturedAt: since + 120_000 },
          // After a server restart the application was handed id 3.
          { clientId: '3', name: 'api', addr: '10.0.0.1:7', age: 0, capturedAt: since + 120_000 },
          { clientId: '3', name: 'api', addr: '10.0.0.1:7', age: 60, capturedAt: since + 180_000 },
        ]),
      );
      const own = [
        { id: '3', connectedAt: since, closedAt: since + 90_000 },
        { id: '2', connectedAt: since + 100_000 },
      ];

      expect(await h.storage.getClientConnections('conn-x', since, until, own)).toEqual([
        expect.objectContaining({
          clientId: '3',
          addr: '10.0.0.1:7',
          name: 'api',
          openedAt: since + 120_000,
          firstCapturedAt: since + 120_000,
          lastCapturedAt: since + 180_000,
        }),
      ]);
      const captures = await h.storage.getClientConnectionCaptures('conn-x', since, until, own);
      expect(captures.sort((x, y) => x.capturedAt - y.capturedAt)).toEqual([
        expect.objectContaining({ capturedAt: since + 120_000, name: 'api', ip: '10.0.0.1', maxClientId: 3 }),
        expect.objectContaining({ capturedAt: since + 180_000, name: 'api', ip: '10.0.0.1', maxClientId: 3 }),
      ]);
    });
  });

  describe('getClientConnectionCaptures', () => {
    const since = 1_000_000;
    const until = 2_000_000;
    const rows = (overrides: Array<Partial<ReturnType<typeof client>>>) =>
      overrides.map((o) => ({ ...client(since), ...o }));

    it('reads the oldest connection and highest id of each identity per capture', async () => {
      await save(
        h.storage,
        rows([
          { clientId: '7', name: 'api', addr: '10.0.0.1:1', age: 90, capturedAt: since },
          { clientId: '12', name: 'api', addr: '10.0.0.1:2', age: 4, capturedAt: since },
          { clientId: '40', name: 'api', addr: '10.0.0.1:3', age: 1, capturedAt: since + 60_000 },
        ]),
      );

      const captures = await h.storage.getClientConnectionCaptures('conn-x', since, until);
      expect(captures.sort((x, y) => x.capturedAt - y.capturedAt)).toEqual([
        {
          capturedAt: since,
          name: 'api',
          user: 'default',
          ip: '10.0.0.1',
          oldestAge: 90,
          maxClientId: 12,
        },
        {
          capturedAt: since + 60_000,
          name: 'api',
          user: 'default',
          ip: '10.0.0.1',
          oldestAge: 1,
          maxClientId: 40,
        },
      ]);
    });

    it('skips replica links, other connections and captures outside the range', async () => {
      await save(
        h.storage,
        rows([
          { clientId: '1', name: 'replica', flags: 'S' },
          { clientId: '2', name: 'late', capturedAt: until + 1 },
          { clientId: '3', name: 'early', capturedAt: since - 1 },
        ]),
      );
      await save(h.storage, rows([{ clientId: '4', name: 'other' }]), 'other');

      expect(await h.storage.getClientConnectionCaptures('conn-x', since, until)).toEqual([]);
    });

    it('groups a client under the name it set later in every capture', async () => {
      const storm = { addr: '10.0.0.5:4001', user: 'default' };
      await save(
        h.storage,
        rows([
          { clientId: '7', name: '', ...storm, age: 1, capturedAt: since },
          { clientId: '7', name: 'storm', ...storm, age: 61, capturedAt: since + 60_000 },
        ]),
      );

      const captures = await h.storage.getClientConnectionCaptures('conn-x', since, until);
      expect(captures.sort((x, y) => x.capturedAt - y.capturedAt)).toEqual([
        { capturedAt: since, name: 'storm', user: 'default', ip: '10.0.0.5', oldestAge: 1, maxClientId: 7 },
        {
          capturedAt: since + 60_000,
          name: 'storm',
          user: 'default',
          ip: '10.0.0.5',
          oldestAge: 61,
          maxClientId: 7,
        },
      ]);
    });

    it("leaves the monitor's own connections out", async () => {
      await save(
        h.storage,
        rows([
          { clientId: '9', name: 'acme-monitor', age: 1 },
          { clientId: '3', name: 'api', age: 5 },
        ]),
      );

      expect(
        await h.storage.getClientConnectionCaptures('conn-x', since, until, [{ id: '9', connectedAt: 0 }]),
      ).toEqual([expect.objectContaining({ name: 'api', oldestAge: 5, maxClientId: 3 })]);
    });
  });

  describe('getClientSnapshotBounds', () => {
    it('is null for a connection with no rows', async () => {
      await save(h.storage, [client(1_000)], 'other');
      expect(await h.storage.getClientSnapshotBounds('conn-x')).toBeNull();
    });

    it('returns min and max captured_at for that connection only', async () => {
      await save(h.storage, [client(2_000), client(5_000), client(3_000)]);
      await save(h.storage, [client(1_000), client(9_000)], 'other');
      expect(await h.storage.getClientSnapshotBounds('conn-x')).toEqual({ earliest: 2_000, latest: 5_000 });
    });
  });

  describe('getClientSnapshotNextCapturedAt', () => {
    it('returns the next capture strictly after the argument, as a number', async () => {
      await save(h.storage, [client(2_000), client(2_000, { name: 'worker' }), client(5_000), client(3_000)]);
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 0)).toBe(2_000);
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 1_999)).toBe(2_000);
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 2_000)).toBe(3_000);
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 4_999)).toBe(5_000);
      expect(typeof (await h.storage.getClientSnapshotNextCapturedAt('conn-x', 0))).toBe('number');
    });

    it('is null at or past the newest row', async () => {
      await save(h.storage, [client(2_000), client(5_000)]);
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 5_000)).toBeNull();
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 9_000)).toBeNull();
    });

    it('scopes to the connection', async () => {
      await save(h.storage, [client(2_000), client(8_000)]);
      await save(h.storage, [client(3_000), client(9_000)], 'other');
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 2_000)).toBe(8_000);
      expect(await h.storage.getClientSnapshotNextCapturedAt('other', 3_000)).toBe(9_000);
      expect(await h.storage.getClientSnapshotNextCapturedAt('conn-x', 8_000)).toBeNull();
      expect(await h.storage.getClientSnapshotNextCapturedAt('nope', 0)).toBeNull();
    });
  });

  describe('getClientSnapshotGroups', () => {
    it('is exclusive at the start and inclusive at the end', async () => {
      await save(h.storage, [client(1_000), client(2_000), client(3_000), client(4_000)]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 1_000, 3_000);
      expect(groups.map((g) => g.capturedAt)).toEqual([2_000, 3_000]);
    });

    it('scopes to the connection', async () => {
      await save(h.storage, [client(2_000)]);
      await save(h.storage, [client(2_000), client(2_000)], 'other');
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups).toEqual([
        { capturedAt: 2_000, name: 'api', user: 'default', ip: '10.1.1.1', count: 1, ageSum: 10 },
      ]);
    });

    it('groups by ip with the port stripped and keeps a colon-free addr whole', async () => {
      await save(h.storage, [
        client(2_000, { addr: '10.1.1.1:5000', age: 3 }),
        client(2_000, { addr: '10.1.1.1:6000', age: 4 }),
        client(2_000, { addr: '/tmp/valkey.sock', age: 5 }),
      ]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups).toEqual([
        { capturedAt: 2_000, name: 'api', user: 'default', ip: '/tmp/valkey.sock', count: 1, ageSum: 5 },
        { capturedAt: 2_000, name: 'api', user: 'default', ip: '10.1.1.1', count: 2, ageSum: 7 },
      ]);
    });

    it('normalises empty name and user to empty strings', async () => {
      await save(h.storage, [client(2_000, { name: '', user: '' })]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups).toEqual([
        { capturedAt: 2_000, name: '', user: '', ip: '10.1.1.1', count: 1, ageSum: 10 },
      ]);
    });

    it('orders by captured_at, then name, user and ip', async () => {
      await save(h.storage, [
        client(3_000, { name: 'b' }),
        client(1_000, { name: 'z' }),
        client(3_000, { name: 'a', user: 'u2' }),
        client(3_000, { name: 'a', user: 'u1', addr: '10.0.0.9:1' }),
        client(3_000, { name: 'a', user: 'u1', addr: '10.0.0.1:1' }),
        client(2_000, { name: 'm' }),
      ]);
      const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
      expect(groups.map((g) => [g.capturedAt, g.name, g.user, g.ip])).toEqual([
        [1_000, 'z', 'default', '10.1.1.1'],
        [2_000, 'm', 'default', '10.1.1.1'],
        [3_000, 'a', 'u1', '10.0.0.1'],
        [3_000, 'a', 'u1', '10.0.0.9'],
        [3_000, 'a', 'u2', '10.1.1.1'],
        [3_000, 'b', 'default', '10.1.1.1'],
      ]);
    });
  });

  describe('rollup rows', () => {
    it('round-trips every field, JSON included', async () => {
      const row = rollup('conn-a', 10 * BUCKET);
      await h.storage.upsertClientAnalyticsRollups([row]);
      expect(await h.storage.getClientAnalyticsRollups(0, 100 * BUCKET)).toEqual([row]);
    });

    it('replaces a bucket row on conflict', async () => {
      await h.storage.upsertClientAnalyticsRollups([rollup('conn-a', BUCKET)]);
      const replacement = rollup('conn-a', BUCKET, {
        rowCount: 99,
        byName: {},
        byUser: { app: { last: 1, peak: 2 } },
        byUserAndName: {},
        ips: [],
        updatedAt: 5,
      });
      await h.storage.upsertClientAnalyticsRollups([replacement]);
      expect(await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET)).toEqual([replacement]);
    });

    it('accepts an empty batch', async () => {
      await h.storage.upsertClientAnalyticsRollups([]);
      expect(await h.storage.getClientAnalyticsRollups(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    });

    it('reads an inclusive bucket range ordered by bucket then connection, optionally filtered', async () => {
      await h.storage.upsertClientAnalyticsRollups([
        rollup('conn-b', 2 * BUCKET),
        rollup('conn-a', 3 * BUCKET),
        rollup('conn-a', 2 * BUCKET),
        rollup('conn-b', 1 * BUCKET),
        rollup('conn-a', 4 * BUCKET),
      ]);
      const all = await h.storage.getClientAnalyticsRollups(2 * BUCKET, 3 * BUCKET);
      expect(all.map((r) => [r.bucketStart, r.connectionId])).toEqual([
        [2 * BUCKET, 'conn-a'],
        [2 * BUCKET, 'conn-b'],
        [3 * BUCKET, 'conn-a'],
      ]);
      const onlyB = await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET, 'conn-b');
      expect(onlyB.map((r) => r.bucketStart)).toEqual([BUCKET, 2 * BUCKET]);
    });

    it('reports watermark and floor per connection, null when none', async () => {
      expect(await h.storage.getClientAnalyticsRollupWatermark('conn-a')).toBeNull();
      expect(await h.storage.getClientAnalyticsRollupFloor('conn-a')).toBeNull();
      await h.storage.upsertClientAnalyticsRollups([
        rollup('conn-a', 2 * BUCKET, { lastCapturedAt: 2 * BUCKET + 7 }),
        rollup('conn-a', 5 * BUCKET, { lastCapturedAt: 5 * BUCKET + 9 }),
        rollup('conn-b', 1 * BUCKET, { lastCapturedAt: 9 * BUCKET }),
      ]);
      expect(await h.storage.getClientAnalyticsRollupWatermark('conn-a')).toBe(5 * BUCKET + 9);
      expect(await h.storage.getClientAnalyticsRollupFloor('conn-a')).toBe(2 * BUCKET);
      expect(await h.storage.getClientAnalyticsRollupFloor('conn-b')).toBe(BUCKET);
    });

    it('prunes buckets strictly older than the cutoff, optionally per connection', async () => {
      await h.storage.upsertClientAnalyticsRollups([
        rollup('conn-a', 1 * BUCKET),
        rollup('conn-a', 2 * BUCKET),
        rollup('conn-a', 3 * BUCKET),
        rollup('conn-b', 1 * BUCKET),
        rollup('conn-b', 3 * BUCKET),
      ]);
      expect(await h.storage.pruneOldClientAnalyticsRollups(3 * BUCKET, 'conn-a')).toBe(2);
      expect(
        (await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET)).map((r) => [r.connectionId, r.bucketStart]),
      ).toEqual([
        ['conn-b', BUCKET],
        ['conn-a', 3 * BUCKET],
        ['conn-b', 3 * BUCKET],
      ]);
      expect(await h.storage.pruneOldClientAnalyticsRollups(10 * BUCKET)).toBe(3);
      expect(await h.storage.getClientAnalyticsRollups(0, 10 * BUCKET)).toEqual([]);
    });
  });

  describe('getClientAnalyticsRollupPeak', () => {
    beforeEach(async () => {
      await h.storage.upsertClientAnalyticsRollups(peakRollups());
    });

    for (const [label, connectionId, sinceBucket, expected] of PEAK_CASES) {
      it(`returns the largest peak since the cut-off (${label})`, async () => {
        const peak = await h.storage.getClientAnalyticsRollupPeak(connectionId, sinceBucket);
        expect(peak).toEqual(expected);
        if (peak) {
          expect(typeof peak.peak).toBe('number');
          expect(typeof peak.capturedAt).toBe('number');
        }
      });
    }

    it('is null before any rollup exists', async () => {
      await h.storage.pruneOldClientAnalyticsRollups(Number.MAX_SAFE_INTEGER);
      expect(await h.storage.getClientAnalyticsRollupPeak('conn-a', 0)).toBeNull();
    });
  });

  it('reports the client snapshot index as ready', async () => {
    expect(await h.storage.isClientSnapshotIndexReady()).toBe(true);
  });

  describe('address and identity edge cases', () => {
    const edge = buildEdgeFixture();

    beforeEach(async () => {
      for (const capturedAt of [...new Set(edge.map((r) => r.capturedAt))]) {
        await save(h.storage, edge.filter((r) => r.capturedAt === capturedAt), EDGE_CONNECTION);
      }
    });

    it('strips only a trailing :<digits> port (IPv6, sockets, no port, bare trailing colon)', async () => {
      const groups = await h.storage.getClientSnapshotGroups(EDGE_CONNECTION, 0, Number.MAX_SAFE_INTEGER);
      expect([...new Set(groups.map((g) => g.ip))].sort()).toEqual(EDGE_IPS);
      const stats = await h.storage.getClientAnalyticsStats(undefined, undefined, EDGE_CONNECTION);
      expect(stats.uniqueIps).toBe(EDGE_IPS.length);
      expect(stats).toEqual(referenceStats(edge, undefined, undefined, EDGE_CONNECTION));
    });

    it('buckets the time series by the same ip as the stats', async () => {
      const series = await h.storage.getClientTimeSeries(0, Number.MAX_SAFE_INTEGER, 60_000, EDGE_CONNECTION);
      const addrs = new Set(series.flatMap((p) => Object.keys(p.byAddr)));
      expect([...addrs].sort()).toEqual(EDGE_IPS);
    });

    it('keeps a user or name containing ":" intact, identically on the rollup and raw paths', async () => {
      const raw = await h.storage.getClientAnalyticsStats(undefined, undefined, EDGE_CONNECTION);
      expect(raw.connectionsByUserAndName['svc:ro:api']).toMatchObject({ user: 'svc:ro', name: 'api' });
      expect(raw.connectionsByUserAndName['app:w:1']).toMatchObject({ user: 'app', name: 'w:1' });

      const groups = await h.storage.getClientSnapshotGroups(EDGE_CONNECTION, 0, Number.MAX_SAFE_INTEGER);
      const rollups = foldGroupsIntoRollups(EDGE_CONNECTION, groups, new Map(), 1);
      await h.storage.upsertClientAnalyticsRollups(rollups);
      const stored = await h.storage.getClientAnalyticsRollups(0, Number.MAX_SAFE_INTEGER, EDGE_CONNECTION);
      expect(stored).toEqual(rollups);
      expect(stored[0].byUserAndName['["svc:ro","api"]']).toMatchObject({ user: 'svc:ro', name: 'api' });
      expect(mergeRollupsIntoStats(stored)).toEqual(raw);
    });
  });

  it('keeps pairs whose `${user}:${name}` collide apart, identically on the rollup and raw paths', async () => {
    const rows = buildCollidingPairFixture();
    for (const capturedAt of [...new Set(rows.map((r) => r.capturedAt))]) {
      await save(h.storage, rows.filter((r) => r.capturedAt === capturedAt), COLLIDE_CONNECTION);
    }
    const raw = await h.storage.getClientAnalyticsStats(undefined, undefined, COLLIDE_CONNECTION);
    // One output entry, for ('a', 'b:c') (its internal key sorts first), with its own counts only.
    expect(raw.connectionsByUserAndName).toEqual({ 'a:b:c': { user: 'a', name: 'b:c', current: 4, peak: 4, avgAge: 22 } });

    const groups = await h.storage.getClientSnapshotGroups(COLLIDE_CONNECTION, 0, Number.MAX_SAFE_INTEGER);
    await h.storage.upsertClientAnalyticsRollups(foldGroupsIntoRollups(COLLIDE_CONNECTION, groups, new Map(), 1));
    const stored = await h.storage.getClientAnalyticsRollups(0, Number.MAX_SAFE_INTEGER, COLLIDE_CONNECTION);
    expect(Object.keys(stored[0].byUserAndName).sort()).toEqual([clientPairKey('a', 'b:c'), clientPairKey('a:b', 'c')]);
    expect(stored[0].byUserAndName[clientPairKey('a:b', 'c')]).toMatchObject({ user: 'a:b', name: 'c', last: 2, peak: 3, rows: 5 });
    expect(stored[0].byUserAndName[clientPairKey('a', 'b:c')]).toMatchObject({ user: 'a', name: 'b:c', last: 4, peak: 4, rows: 5 });
    expect(mergeRollupsIntoStats(stored)).toEqual(raw);
  });

  describe('getClientAnalyticsStats parity with the naive reference', () => {
    const rows = buildFixture();

    beforeEach(async () => {
      await seedFixture(h.storage, rows);
    });

    for (const [label, start, end] of STATS_RANGES) {
      it(`matches across all connections (${label})`, async () => {
        expect(await h.storage.getClientAnalyticsStats(start, end)).toEqual(referenceStats(rows, start, end));
      });

      for (const connectionId of CONNECTIONS) {
        it(`matches for ${connectionId} (${label})`, async () => {
          expect(await h.storage.getClientAnalyticsStats(start, end, connectionId)).toEqual(
            referenceStats(rows, start, end, connectionId),
          );
        });
      }
    }

    it('resolves a peak tie to the earliest batch', async () => {
      const stats = await h.storage.getClientAnalyticsStats(undefined, undefined, 'conn-b');
      expect(stats.peakConnections).toBe(12);
      expect(stats.peakTimestamp).toBe(T0 + 3 * BATCH_MS);
    });

    it('excludes empty names and users from the grouped maps', async () => {
      const stats = await h.storage.getClientAnalyticsStats();
      expect(Object.keys(stats.connectionsByName)).not.toContain('');
      expect(Object.keys(stats.connectionsByUser)).not.toContain('');
      for (const entry of Object.values(stats.connectionsByUserAndName)) {
        expect(entry.user).not.toBe('');
        expect(entry.name).not.toBe('');
      }
    });
  });
});

describe('SqliteAdapter client analytics specifics', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await sqliteHarness();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  function db() {
    const handle = (h.storage as SqliteAdapter).getRawDatabaseHandle();
    if (handle.kind !== 'sqlite') throw new Error('expected a better-sqlite3 handle');
    return handle.db;
  }

  it('creates the composite and rollup indexes', () => {
    const names = (db().prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[]).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_client_connection_captured',
        'idx_acl_connection_captured',
        'idx_client_rollups_bucket',
      ]),
    );
  });

  it('merges NULL and empty name/user into one empty group', async () => {
    await save(h.storage, [client(2_000, { name: '', user: '' })]);
    db()
      .prepare(
        `INSERT INTO client_snapshots (client_id, addr, name, user, db, age, idle, captured_at, source_host, source_port, connection_id)
         VALUES ('n', '10.1.1.1:1', NULL, NULL, 0, 30, 0, 2000, 'localhost', 6379, 'conn-x')`,
      )
      .run();
    expect(await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000)).toEqual([
      { capturedAt: 2_000, name: '', user: '', ip: '10.1.1.1', count: 2, ageSum: 40 },
    ]);
    const stats = await h.storage.getClientAnalyticsStats(undefined, undefined, 'conn-x');
    expect(stats.uniqueClientNames).toBe(0);
    expect(stats.uniqueUsers).toBe(0);
    expect(stats.currentConnections).toBe(2);
  });
});

describe('clientAddrIp', () => {
  it.each([
    ['1.2.3.4:5678', '1.2.3.4'],
    ['[::1]:6379', '[::1]'],
    ['[::1]', '[::1]'],
    ['/tmp/valkey.sock:0', '/tmp/valkey.sock'],
    ['/tmp/valkey.sock', '/tmp/valkey.sock'],
    ['10.0.0.1', '10.0.0.1'],
    ['host:', 'host:'],
    ['host:12a', 'host:12a'],
    [':123', ''],
    ['1234', '1234'],
    ['a::12', 'a:'],
  ])('%s -> %s', (addr, ip) => {
    expect(clientAddrIp(addr)).toBe(ip);
  });
});

describe('SQLite ip expression matches clientAddrIp', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await sqliteHarness();
  });

  afterAll(async () => {
    await h.cleanup();
  });

  it('agrees on every edge case, including digit-only and mixed tails', async () => {
    const addrs = ['1.2.3.4:5678', '[::1]:6379', '[::1]', '/tmp/valkey.sock:0', 'host', 'host:', 'host:12a',
      'host:a12', ':123', ':', '1234', 'a::12', 'fe80::1', 'x:1:2', 'h:00', '9:'];
    await save(
      h.storage,
      addrs.map((addr, i) => client(1_000, { addr, name: `n${i}` })),
    );
    const groups = await h.storage.getClientSnapshotGroups('conn-x', 0, 10_000);
    const byName = new Map(groups.map((g) => [g.name, g.ip]));
    addrs.forEach((addr, i) => expect([addr, byName.get(`n${i}`)]).toEqual([addr, clientAddrIp(addr)]));
  });
});

/** Probe points for getClientSnapshotNextCapturedAt: before, on, between and past the captures. */
function nextProbes(bounds: { earliest: number; latest: number } | null): number[] {
  const probes = [0, T0 - 1, T0, T0 + 3 * BATCH_MS - 1, T0 + 3 * BATCH_MS, T0 + 50 * BATCH_MS + 1];
  if (bounds) probes.push(bounds.earliest, bounds.latest - 1, bounds.latest, bounds.latest + 1);
  return probes;
}

describe('cross-adapter identity (MemoryAdapter vs SqliteAdapter)', () => {
  const rows = buildFixture();
  const edge = buildEdgeFixture();
  let memory: Harness;
  let sqlite: Harness;

  beforeAll(async () => {
    memory = await memoryHarness();
    sqlite = await sqliteHarness();
    await seedFixture(memory.storage, rows);
    await seedFixture(sqlite.storage, rows);
    for (const capturedAt of [...new Set(edge.map((r) => r.capturedAt))]) {
      const batch = edge.filter((r) => r.capturedAt === capturedAt);
      await save(memory.storage, batch, EDGE_CONNECTION);
      await save(sqlite.storage, batch, EDGE_CONNECTION);
    }
  });

  it('returns identical groups, stats and time series for address edge cases', async () => {
    const end = Number.MAX_SAFE_INTEGER;
    expect(await sqlite.storage.getClientSnapshotGroups(EDGE_CONNECTION, 0, end)).toEqual(
      await memory.storage.getClientSnapshotGroups(EDGE_CONNECTION, 0, end),
    );
    expect(await sqlite.storage.getClientAnalyticsStats(undefined, undefined, EDGE_CONNECTION)).toEqual(
      await memory.storage.getClientAnalyticsStats(undefined, undefined, EDGE_CONNECTION),
    );
    expect(await sqlite.storage.getClientTimeSeries(0, end, 60_000, EDGE_CONNECTION)).toEqual(
      await memory.storage.getClientTimeSeries(0, end, 60_000, EDGE_CONNECTION),
    );
  });

  afterAll(async () => {
    await memory.cleanup();
    await sqlite.cleanup();
  });

  const windows: Array<[number, number]> = [
    [0, Number.MAX_SAFE_INTEGER],
    [T0, T0 + 10 * BATCH_MS],
    [T0 + 3 * BATCH_MS - 1, T0 + 3 * BATCH_MS],
    [T0 + 50 * BATCH_MS, T0 + 60 * BATCH_MS],
  ];

  for (const connectionId of CONNECTIONS) {
    it(`returns identical groups, bounds and next captures for ${connectionId}`, async () => {
      const bounds = await memory.storage.getClientSnapshotBounds(connectionId);
      expect(await sqlite.storage.getClientSnapshotBounds(connectionId)).toEqual(bounds);
      for (const after of nextProbes(bounds)) {
        expect(await sqlite.storage.getClientSnapshotNextCapturedAt(connectionId, after)).toBe(
          await memory.storage.getClientSnapshotNextCapturedAt(connectionId, after),
        );
      }
      for (const [start, end] of windows) {
        const expected = await memory.storage.getClientSnapshotGroups(connectionId, start, end);
        expect(await sqlite.storage.getClientSnapshotGroups(connectionId, start, end)).toEqual(expected);
      }
    });
  }

  it('returns identical rollup peaks', async () => {
    await memory.storage.upsertClientAnalyticsRollups(peakRollups());
    await sqlite.storage.upsertClientAnalyticsRollups(peakRollups());
    for (const [, connectionId, sinceBucket] of PEAK_CASES) {
      expect(await sqlite.storage.getClientAnalyticsRollupPeak(connectionId, sinceBucket)).toEqual(
        await memory.storage.getClientAnalyticsRollupPeak(connectionId, sinceBucket),
      );
    }
  });

  for (const [label, start, end] of STATS_RANGES) {
    it(`returns identical stats (${label})`, async () => {
      expect(await sqlite.storage.getClientAnalyticsStats(start, end)).toEqual(
        await memory.storage.getClientAnalyticsStats(start, end),
      );
      for (const connectionId of CONNECTIONS) {
        expect(await sqlite.storage.getClientAnalyticsStats(start, end, connectionId)).toEqual(
          await memory.storage.getClientAnalyticsStats(start, end, connectionId),
        );
      }
    });
  }
});
