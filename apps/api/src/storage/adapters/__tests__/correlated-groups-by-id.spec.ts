import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type {
  StoragePort,
  StoredCorrelatedGroup,
} from '../../../common/interfaces/storage-port.interface';

describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('getCorrelatedGroups by correlation id (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

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
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
    await storage.saveCorrelatedGroup(group('grp-1', 1000), CONN);
    await storage.saveCorrelatedGroup(group('grp-2', 2000), CONN);
    await storage.saveCorrelatedGroup(group('grp-3', 3000), CONN);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns only the requested groups', async () => {
    const rows = await storage.getCorrelatedGroups({
      connectionId: CONN,
      correlationIds: ['grp-1', 'grp-3'],
    });

    expect(rows.map((g) => g.correlationId)).toEqual(['grp-3', 'grp-1']);
  });

  it('returns nothing for an empty id list', async () => {
    const rows = await storage.getCorrelatedGroups({ connectionId: CONN, correlationIds: [] });

    expect(rows).toEqual([]);
  });
});
