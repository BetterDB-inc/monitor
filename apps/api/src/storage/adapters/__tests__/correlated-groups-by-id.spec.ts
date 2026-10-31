import { randomUUID } from 'crypto';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  StoragePort,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
} from '../../../common/interfaces/storage-port.interface';

describe.each<[string, AdapterFactory]>(adapters)(
  'getCorrelatedGroups filters (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;
    const CONN = 'conn-a';
    const [ID1, ID2, ID3] = [randomUUID(), randomUUID(), randomUUID()];

    const group = (correlationId: string, timestamp: number): StoredCorrelatedGroup => ({
      correlationId,
      timestamp,
      pattern: 'memory_pressure',
      severity: 'warning',
      diagnosis: 'd',
      recommendations: [],
      anomalyCount: 1,
      metricTypes: ['connections'],
    });

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
      await storage.saveCorrelatedGroup(group(ID1, 1000), CONN);
      await storage.saveCorrelatedGroup(group(ID2, 2000), CONN);
      await storage.saveCorrelatedGroup(group(ID3, 3000), CONN);
    });

    afterEach(async () => {
      await cleanup();
    });

    it('filters by several connections and patterns', async () => {
      const other = randomUUID();
      await storage.saveCorrelatedGroup({ ...group(other, 500), pattern: 'batch_job' }, 'conn-b');
      await storage.saveCorrelatedGroup(group(randomUUID(), 600), 'conn-c');

      const rows = await storage.getCorrelatedGroups({
        scope: { id: 'unused', connectionIds: ['conn-b', 'conn-c'] },
        patterns: ['batch_job'],
      });

      expect(rows.map((g) => g.correlationId)).toEqual([other]);
      expect(
        await storage.getCorrelatedGroups({ scope: { id: 'unused', connectionIds: [] } }),
      ).toEqual([]);
      expect(await storage.getCorrelatedGroups({ patterns: [] })).toEqual([]);
    });

    it('breaks timestamp ties by correlation id', async () => {
      const [low, high] = [randomUUID(), randomUUID()].sort();
      await storage.saveCorrelatedGroup(group(low, 9000), CONN);
      await storage.saveCorrelatedGroup(group(high, 9000), CONN);

      const rows = await storage.getCorrelatedGroups({ connectionId: CONN, limit: 2 });

      expect(rows.map((g) => g.correlationId)).toEqual([high, low]);
    });

    it('round-trips stored member ids', async () => {
      const ids = [randomUUID(), randomUUID()];
      const withIds = randomUUID();
      await storage.saveCorrelatedGroup({ ...group(withIds, 4000), anomalyIds: ids }, CONN);

      const rows = await storage.getCorrelatedGroups({ connectionId: CONN, limit: 2 });

      expect(rows.map((g) => g.anomalyIds)).toEqual([ids, undefined]);
    });

    describe('groups involving a connection', () => {
      const event = (
        id: string,
        connectionId: string,
        correlationId: string | undefined,
        timestamp: number,
      ): StoredAnomalyEvent => ({
        id,
        timestamp,
        metricType: 'connections',
        anomalyType: 'spike',
        severity: 'warning',
        value: 1,
        baseline: 0,
        stdDev: 0,
        zScore: 0,
        threshold: 0,
        message: 'm',
        correlationId,
        resolved: false,
        connectionId,
      });
      const save = (e: StoredAnomalyEvent) => storage.saveAnomalyEvent(e, e.connectionId!);

      it('finds own groups and sibling groups the connection took part in', async () => {
        const shared = randomUUID();
        const unrelated = randomUUID();
        await storage.saveCorrelatedGroup(group(shared, 5000), 'conn-b');
        await storage.saveCorrelatedGroup(group(unrelated, 6000), 'conn-b');
        await save(event(randomUUID(), CONN, shared, 5000));
        await save(event(randomUUID(), 'conn-b', unrelated, 6000));

        const rows = await storage.getCorrelatedGroups({ involvingConnectionId: CONN });

        expect(rows.map((g) => g.correlationId)).toEqual([shared, ID3, ID2, ID1]);
      });

      it('reaches an old shared group behind many solo events and honours the limit', async () => {
        const shared = randomUUID();
        await storage.saveCorrelatedGroup(group(shared, 500), 'conn-b');
        await save(event(randomUUID(), CONN, shared, 500));
        for (let i = 0; i < 20; i += 1) {
          await save(event(randomUUID(), CONN, randomUUID(), 10_000 + i));
        }

        const rows = await storage.getCorrelatedGroups({
          involvingConnectionId: CONN,
          scope: { id: 'unused', connectionIds: ['conn-b'] },
          startTime: 100,
          limit: 1,
        });

        expect(rows.map((g) => g.correlationId)).toEqual([shared]);
      });

      it('applies the window and pattern filters', async () => {
        const shared = randomUUID();
        await storage.saveCorrelatedGroup(group(shared, 5000), 'conn-b');
        await save(event(randomUUID(), CONN, shared, 5000));

        const late = await storage.getCorrelatedGroups({
          involvingConnectionId: CONN,
          startTime: 5001,
        });
        const otherPattern = await storage.getCorrelatedGroups({
          involvingConnectionId: CONN,
          pattern: 'batch_job',
        });

        expect(late).toEqual([]);
        expect(otherPattern).toEqual([]);
      });

      it('reads members by group and by id, across connections, oldest first', async () => {
        const shared = randomUUID();
        const [a, b, c, noise] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await save(event(a, CONN, shared, 200));
        await save(event(b, 'conn-b', shared, 100));
        await save(event(c, 'conn-c', undefined, 300));
        await save(event(noise, CONN, randomUUID(), 400));

        const rows = await storage.getCorrelatedGroupMembers([shared], [c], 100);

        expect(rows.map((e) => e.id)).toEqual([b, a, c]);
      });

      it('returns the replica address of a member', async () => {
        const shared = randomUUID();
        const id = randomUUID();
        await save({ ...event(id, CONN, shared, 200), replicaAddr: '10.0.0.2:6379' });

        const [member] = await storage.getCorrelatedGroupMembers([shared], [], 100);

        expect(member.replicaAddr).toBe('10.0.0.2:6379');
      });

      it('returns no members for empty lists and ignores ids storage cannot hold', async () => {
        expect(await storage.getCorrelatedGroupMembers([], [], 100)).toEqual([]);
        expect(await storage.getCorrelatedGroupMembers([], ['failover:conn-a:1'], 100)).toEqual([]);
      });

      it('keeps the newest members of each group up to the bound', async () => {
        const [big, small] = [randomUUID(), randomUUID()];
        const solo = randomUUID();
        const bigIds = Array.from({ length: 5 }, () => randomUUID());
        for (const [i, id] of bigIds.entries()) await save(event(id, CONN, big, 100 + i));
        const smallId = randomUUID();
        await save(event(smallId, CONN, small, 50));
        await save(event(solo, CONN, undefined, 60));

        const rows = await storage.getCorrelatedGroupMembers([big, small], [solo], 2);

        expect(rows.map((e) => e.id)).toEqual([smallId, solo, bigIds[3], bigIds[4]]);
      });
    });
  },
);
