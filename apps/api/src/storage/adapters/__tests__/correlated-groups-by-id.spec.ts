import { randomUUID } from 'crypto';
import { adapters, type AdapterFactory } from './anomaly-storage-adapters';
import type {
  StoragePort,
  StoredCorrelatedGroup,
} from '../../../common/interfaces/storage-port.interface';

describe.each<[string, AdapterFactory]>(adapters)(
  'getCorrelatedGroups by correlation id (%s)',
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

    it('returns only the requested groups', async () => {
      const rows = await storage.getCorrelatedGroups({
        connectionId: CONN,
        correlationIds: [ID1, ID3],
      });

      expect(rows.map((g) => g.correlationId)).toEqual([ID3, ID1]);
    });

    it('returns nothing for an empty id list', async () => {
      const rows = await storage.getCorrelatedGroups({ connectionId: CONN, correlationIds: [] });

      expect(rows).toEqual([]);
    });
  },
);
