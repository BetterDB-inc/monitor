import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoragePort, StoredAnomalyEvent } from '../../../common/interfaces/storage-port.interface';

describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('resolveAnomaly idempotency (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

  const event = (id: string): StoredAnomalyEvent => ({
    id,
    timestamp: 1_700_000_000_000,
    metricType: 'dataset_keys',
    anomalyType: 'drop',
    severity: 'critical',
    value: 0,
    baseline: 100,
    stdDev: 0,
    zScore: 0,
    threshold: 0,
    message: 'CRITICAL: data loss',
    resolved: false,
  });

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns true on first resolve and true again on re-resolve (idempotent)', async () => {
    await storage.saveAnomalyEvent(event('evt-1'), CONN);

    expect(await storage.resolveAnomaly('evt-1', 1_700_000_100_000)).toBe(true);
    // A retry / a second path resolving the same row must still report success,
    // so a group resolve isn't failed by an already-closed member.
    expect(await storage.resolveAnomaly('evt-1', 1_700_000_200_000)).toBe(true);

    const [stored] = await storage.getAnomalyEvents({ connectionId: CONN });
    expect(stored.resolved).toBe(true);
  });

  it('returns false only when no anomaly with that id exists', async () => {
    expect(await storage.resolveAnomaly('does-not-exist', 1_700_000_100_000)).toBe(false);
  });
});
