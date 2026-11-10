import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  AnomalyQueryOptions,
  StoragePort,
  StoredAnomalyEvent,
} from '../../../common/interfaces/storage-port.interface';

const CONN = 'conn-a';

const event = (
  id: string,
  timestamp: number,
  overrides: Partial<StoredAnomalyEvent> = {},
): StoredAnomalyEvent => ({
  id,
  timestamp,
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
  ...overrides,
});

describe.each<[string, AdapterFactory]>(adapters)(
  'getAnomalyEvents node filter (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;

    const ids = async (options: AnomalyQueryOptions) =>
      (await storage.getAnomalyEvents({ connectionId: CONN, order: 'asc', ...options })).map(
        (e) => e.id,
      );

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
      const seeded = [
        event('a', 1000, { nodeAddr: '10.0.0.1:6379' }),
        event('b', 2000, { nodeAddr: '10.0.0.2:6379' }),
        event('c', 3000),
        event('d', 4000, { nodeAddr: '' }),
        event('e', 5000, { nodeAddr: '10.0.0.1:6379' }),
      ];
      for (const e of seeded) await storage.saveAnomalyEvent(e, CONN);
    });

    afterEach(async () => {
      await cleanup();
    });

    it('returns every event when no node filter is given', async () => {
      expect(await ids({})).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('returns only the events of the given node', async () => {
      expect(await ids({ nodeAddr: '10.0.0.1:6379' })).toEqual(['a', 'e']);
    });

    it('returns events with a missing or empty node address for a null filter', async () => {
      expect(await ids({ nodeAddr: null })).toEqual(['c', 'd']);
    });

    it('treats an empty node filter like null', async () => {
      expect(await ids({ nodeAddr: '' })).toEqual(['c', 'd']);
    });

    it('returns the earliest matching event after a time, not the earliest event', async () => {
      expect(await ids({ nodeAddr: '10.0.0.1:6379', startTime: 1001, limit: 1 })).toEqual(['e']);
    });
  },
);
