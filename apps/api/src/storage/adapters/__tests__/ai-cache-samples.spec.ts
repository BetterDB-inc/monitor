import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type { StoragePort } from '../../../common/interfaces/storage-port.interface';
import type { StoredAiCacheSample } from '@betterdb/shared';

describe.each([
  ['MemoryAdapter', () => new MemoryAdapter()],
  ['SqliteAdapter', () => new SqliteAdapter({ filepath: ':memory:' })],
])('AiCache samples storage (%s)', (_name, makeAdapter) => {
  let storage: StoragePort;
  const CONN = 'conn-a';

  beforeEach(async () => {
    storage = makeAdapter() as unknown as StoragePort;
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  const sample = (
    overrides: Partial<Omit<StoredAiCacheSample, 'id' | 'connectionId'>> = {},
  ): Omit<StoredAiCacheSample, 'id' | 'connectionId'> => ({
    instanceField: 'app',
    instanceName: 'app',
    kind: 'agent_cache',
    timestamp: 1_700_000_000_000,
    hits: 100,
    misses: 25,
    hitRate: 0.8,
    costSavedMicros: 12_500_000,
    evictions: 0,
    items: null,
    indexBytes: null,
    threshold: null,
    extra: null,
    ...overrides,
  });

  it('persists and returns samples scoped to a connection', async () => {
    await storage.saveAiCacheSamples([sample({ timestamp: 1000 })], CONN);
    await storage.saveAiCacheSamples([sample({ timestamp: 2000, hits: 1 })], 'conn-b');

    const history = await storage.getAiCacheHistory({
      connectionId: CONN,
      startTime: 0,
      endTime: 10_000,
    });

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      connectionId: CONN,
      instanceField: 'app',
      kind: 'agent_cache',
      hits: 100,
      misses: 25,
      hitRate: 0.8,
      costSavedMicros: 12_500_000,
      timestamp: 1000,
    });
  });

  it('preserves nullable fields and kind-specific values', async () => {
    await storage.saveAiCacheSamples(
      [
        sample({
          instanceField: 'app:mem',
          instanceName: 'app',
          kind: 'agent_memory',
          timestamp: 1000,
          items: 4200,
          indexBytes: 1_048_576,
          threshold: 0.42,
          extra: JSON.stringify({ weights: { similarity: 0.6 } }),
        }),
      ],
      CONN,
    );

    const [row] = await storage.getAiCacheHistory({ connectionId: CONN, instanceField: 'app:mem' });
    expect(row.kind).toBe('agent_memory');
    expect(row.items).toBe(4200);
    expect(row.indexBytes).toBe(1_048_576);
    expect(row.threshold).toBeCloseTo(0.42);
    expect(row.extra).toContain('similarity');
  });

  it('filters by time window and kind', async () => {
    await storage.saveAiCacheSamples([sample({ timestamp: 1000, kind: 'agent_cache', instanceField: 'a' })], CONN);
    await storage.saveAiCacheSamples([sample({ timestamp: 5000, kind: 'semantic_cache', instanceField: 'b' })], CONN);

    const windowed = await storage.getAiCacheHistory({ connectionId: CONN, startTime: 4000, endTime: 6000 });
    expect(windowed).toHaveLength(1);
    expect(windowed[0].timestamp).toBe(5000);

    const byKind = await storage.getAiCacheHistory({ connectionId: CONN, kind: 'semantic_cache' });
    expect(byKind).toHaveLength(1);
    expect(byKind[0].kind).toBe('semantic_cache');
  });

  it('caps history PER INSTANCE, keeping the newest (ascending order)', async () => {
    // Two instances, 3 samples each. A global cap of 2 would drop one instance entirely;
    // the per-instance cap keeps the 2 newest of EACH.
    for (const field of ['a', 'b']) {
      for (const ts of [1000, 2000, 3000]) {
        await storage.saveAiCacheSamples(
          [sample({ instanceField: field, instanceName: field, timestamp: ts })],
          CONN,
        );
      }
    }

    const history = await storage.getAiCacheHistory({ connectionId: CONN, limit: 2 });
    const byField = new Map<string, number[]>();
    for (const r of history) {
      byField.set(r.instanceField, [...(byField.get(r.instanceField) ?? []), r.timestamp]);
    }
    expect(byField.get('a')).toEqual([2000, 3000]);
    expect(byField.get('b')).toEqual([2000, 3000]);
  });

  it('prunes samples older than a cutoff', async () => {
    await storage.saveAiCacheSamples([sample({ timestamp: 1000 })], CONN);
    await storage.saveAiCacheSamples([sample({ timestamp: 9000 })], CONN);

    const removed = await storage.pruneOldAiCacheSamples(5000, CONN);
    expect(removed).toBe(1);

    const remaining = await storage.getAiCacheHistory({ connectionId: CONN });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].timestamp).toBe(9000);
  });
});
