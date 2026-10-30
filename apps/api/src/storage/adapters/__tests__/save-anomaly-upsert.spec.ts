import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoragePort, StoredAnomalyEvent } from '../../../common/interfaces/storage-port.interface';

describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('saveAnomalyEvent upsert (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

  const event = (overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent => ({
    id: 'evt-1',
    timestamp: 1_700_000_000_000,
    metricType: 'command_p99',
    anomalyType: 'spike',
    severity: 'warning',
    value: 900,
    baseline: 300,
    stdDev: 0,
    zScore: 0,
    threshold: 3,
    message: 'P99 regression',
    resolved: false,
    ...overrides,
  });

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('keeps one row when the same event is saved again with a correlation id', async () => {
    await storage.saveAnomalyEvent(event(), CONN);
    await storage.saveAnomalyEvent(
      event({ correlationId: 'grp-1', relatedMetrics: ['cluster_state'], message: 'changed' }),
      CONN,
    );

    const rows = await storage.getAnomalyEvents({ connectionId: CONN });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        correlationId: 'grp-1',
        relatedMetrics: ['cluster_state'],
        message: 'P99 regression',
      }),
    );
  });
});
