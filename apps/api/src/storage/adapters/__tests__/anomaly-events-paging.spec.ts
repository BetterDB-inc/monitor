import { randomUUID } from 'crypto';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  StoragePort,
  StoredAnomalyEvent,
} from '../../../common/interfaces/storage-port.interface';

describe.each<[string, AdapterFactory]>(adapters)(
  'getAnomalyEvents paging within one poll (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;
    const CONN = 'conn-a';
    const TIMESTAMP = 1_000;

    const event = (id: string): StoredAnomalyEvent => ({
      id,
      timestamp: TIMESTAMP,
      metricType: 'connections',
      anomalyType: 'spike',
      severity: 'warning',
      value: 1,
      baseline: 1,
      stdDev: 1,
      zScore: 1,
      threshold: 1,
      message: 'm',
      resolved: false,
    });

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
    });

    afterEach(async () => {
      await cleanup();
    });

    it('filters by the time a row was saved, not its own timestamp', async () => {
      await storage.saveAnomalyEvent(event(randomUUID()), CONN);

      const [saved] = await storage.getAnomalyEvents({ connectionId: CONN });
      const insertedSince = saved.insertedAt!;
      const atWatermark = await storage.getAnomalyEvents({ connectionId: CONN, insertedSince });
      const later = await storage.getAnomalyEvents({
        connectionId: CONN,
        insertedSince: insertedSince + 3_600_000,
      });

      expect(insertedSince).toBeGreaterThan(TIMESTAMP);
      expect(atWatermark.map((e) => e.id)).toEqual([saved.id]);
      expect(later).toEqual([]);
    });

    it('returns events that share a timestamp in id order across pages', async () => {
      const ids = Array.from({ length: 12 }, () => randomUUID());
      for (const id of ids) await storage.saveAnomalyEvent(event(id), CONN);

      const pages: string[] = [];
      for (let offset = 0; offset < ids.length; offset += 5) {
        const page = await storage.getAnomalyEvents({ connectionId: CONN, limit: 5, offset });
        pages.push(...page.map((e) => e.id));
      }

      expect(pages).toEqual([...ids].sort().reverse());
    });
  },
);
