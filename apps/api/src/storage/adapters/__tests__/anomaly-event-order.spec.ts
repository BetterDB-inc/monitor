import { randomUUID } from 'crypto';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  StoragePort,
  StoredAnomalyEvent,
} from '../../../common/interfaces/storage-port.interface';

describe.each<[string, AdapterFactory]>(adapters)(
  'getAnomalyEvents order and cursor (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;
    const CONN = 'conn-a';

    const event = (id: string, timestamp: number): StoredAnomalyEvent => ({
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
      resolved: false,
      connectionId: CONN,
    });

    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()].sort();

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
      await storage.saveAnomalyEvents(
        [event(ids[2], 1000), event(ids[0], 2000), event(ids[1], 2000), event(ids[3], 3000)],
        CONN,
      );
    });

    afterEach(async () => {
      await cleanup();
    });

    it('breaks timestamp ties by id, newest first', async () => {
      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows.map((r) => r.id)).toEqual([ids[3], ids[1], ids[0], ids[2]]);
    });

    it('returns the earliest match when ascending', async () => {
      const rows = await storage.getAnomalyEvents({
        connectionId: CONN,
        startTime: 1500,
        order: 'asc',
        limit: 1,
      });

      expect(rows.map((r) => r.id)).toEqual([ids[0]]);
    });

    it('walks every row across pages split inside a timestamp tie', async () => {
      const seen: string[] = [];
      let after: { timestamp: number; id: string } | undefined;
      for (let i = 0; i < 4; i += 1) {
        const [row] = await storage.getAnomalyEvents({ connectionId: CONN, limit: 1, after });
        seen.push(row.id);
        after = row;
      }

      expect(seen).toEqual([ids[3], ids[1], ids[0], ids[2]]);
      expect(await storage.getAnomalyEvents({ connectionId: CONN, after })).toEqual([]);
    });

    it('walks forward from a cursor when ascending', async () => {
      const rows = await storage.getAnomalyEvents({
        connectionId: CONN,
        order: 'asc',
        after: { timestamp: 2000, id: ids[0] },
      });

      expect(rows.map((r) => r.id)).toEqual([ids[1], ids[3]]);
    });
  },
);
