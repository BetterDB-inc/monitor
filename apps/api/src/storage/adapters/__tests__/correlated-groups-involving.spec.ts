import { randomUUID } from 'crypto';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  StoragePort,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
} from '../../../common/interfaces/storage-port.interface';

describe.each<[string, AdapterFactory]>(adapters)(
  'getCorrelatedGroups involving a connection (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;
    const SIBLING = 'conn-sibling';
    const CALLER = 'conn-caller';

    const group = (
      correlationId: string,
      timestamp: number,
      pattern = 'memory_pressure',
    ): StoredCorrelatedGroup => ({
      correlationId,
      timestamp,
      pattern,
      severity: 'warning',
      diagnosis: 'd',
      recommendations: [],
      anomalyCount: 2,
      metricTypes: ['connections'],
    });

    const member = (correlationId: string | undefined, timestamp: number): StoredAnomalyEvent => ({
      id: randomUUID(),
      timestamp,
      metricType: 'connections',
      anomalyType: 'spike',
      severity: 'warning',
      value: 1,
      baseline: 1,
      stdDev: 1,
      zScore: 3,
      threshold: 2,
      message: 'm',
      correlationId,
      resolved: false,
    });

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
    });

    afterEach(async () => {
      await cleanup();
    });

    it('finds an older sibling group behind newer groups the connection has no part in', async () => {
      const shared = randomUUID();
      await storage.saveCorrelatedGroup(group(shared, 1000), SIBLING);
      await storage.saveCorrelatedGroup(group(randomUUID(), 5000), SIBLING);
      await storage.saveCorrelatedGroup(group(randomUUID(), 6000), SIBLING);
      await storage.saveAnomalyEvent(member(shared, 1000), CALLER);

      const rows = await storage.getCorrelatedGroups({
        involving: { connectionId: CALLER, startTime: 0, endTime: 9000 },
        limit: 1,
      });

      expect(rows.map((row) => row.correlationId)).toEqual([shared]);
    });

    it('reaches a group behind any number of plain caller events', async () => {
      const shared = randomUUID();
      await storage.saveCorrelatedGroup(group(shared, 1000), SIBLING);
      await storage.saveAnomalyEvent(member(shared, 1000), CALLER);
      for (let i = 0; i < 20; i++) {
        await storage.saveAnomalyEvent(member(undefined, 2000 + i), CALLER);
      }

      const rows = await storage.getCorrelatedGroups({
        involving: { connectionId: CALLER },
        limit: 5,
      });

      expect(rows.map((row) => row.correlationId)).toEqual([shared]);
    });

    it('applies the group filters on top', async () => {
      const inside = randomUUID();
      const early = randomUUID();
      const otherPattern = randomUUID();
      await storage.saveCorrelatedGroup(group(inside, 2000), SIBLING);
      await storage.saveCorrelatedGroup(group(early, 500), SIBLING);
      await storage.saveCorrelatedGroup(group(otherPattern, 2000, 'batch_job'), SIBLING);
      for (const id of [inside, early, otherPattern]) {
        await storage.saveAnomalyEvent(member(id, 1500), CALLER);
      }

      const rows = await storage.getCorrelatedGroups({
        startTime: 1000,
        pattern: 'memory_pressure',
        involving: { connectionId: CALLER, startTime: 0 },
      });

      expect(rows.map((row) => row.correlationId)).toEqual([inside]);
    });

    it('ignores caller events outside the membership window', async () => {
      const shared = randomUUID();
      await storage.saveCorrelatedGroup(group(shared, 1000), SIBLING);
      await storage.saveAnomalyEvent(member(shared, 1000), CALLER);

      const rows = await storage.getCorrelatedGroups({
        involving: { connectionId: CALLER, startTime: 2000, endTime: 3000 },
      });

      expect(rows).toEqual([]);
    });

    it('returns nothing for a connection with no shared events', async () => {
      await storage.saveCorrelatedGroup(group(randomUUID(), 1000), SIBLING);
      await storage.saveAnomalyEvent(member(undefined, 1000), CALLER);

      const rows = await storage.getCorrelatedGroups({ involving: { connectionId: CALLER } });

      expect(rows).toEqual([]);
    });
  },
);
