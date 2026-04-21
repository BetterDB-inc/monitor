import { MemoryAdapter } from '../memory.adapter';
import type { VectorIndexSnapshot } from '@betterdb/shared';

describe('VectorIndexSnapshot extended fields', () => {
  let storage: MemoryAdapter;
  const CONN = 'conn-test';

  beforeEach(async () => {
    storage = new MemoryAdapter();
    await storage.initialize();
  });

  const makeSnapshot = (overrides: Partial<VectorIndexSnapshot> = {}): VectorIndexSnapshot => {
    return {
      id: 'snap-1',
      timestamp: Date.now(),
      connectionId: CONN,
      indexName: 'idx_test',
      numDocs: 100,
      numRecords: 200,
      numDeletedDocs: 3,
      indexingFailures: 2,
      indexingFailuresDelta: 1,
      percentIndexed: 95,
      indexingState: 'indexed',
      totalIndexingTime: 4200,
      memorySizeMb: 12.5,
      ...overrides,
    };
  };

  it('persists and retrieves all extended fields', async () => {
    const snap = makeSnapshot();
    await storage.saveVectorIndexSnapshots([snap], CONN);

    const [fetched] = await storage.getVectorIndexSnapshots({ connectionId: CONN });

    expect(fetched.numRecords).toBe(200);
    expect(fetched.numDeletedDocs).toBe(3);
    expect(fetched.indexingFailures).toBe(2);
    expect(fetched.indexingFailuresDelta).toBe(1);
    expect(fetched.percentIndexed).toBe(95);
    expect(fetched.indexingState).toBe('indexed');
    expect(fetched.totalIndexingTime).toBe(4200);
  });

  it('defaults delta to 0 when missing', async () => {
    const snap = makeSnapshot({ indexingFailuresDelta: 0 });
    await storage.saveVectorIndexSnapshots([snap], CONN);

    const [fetched] = await storage.getVectorIndexSnapshots({ connectionId: CONN });
    expect(fetched.indexingFailuresDelta).toBe(0);
  });

  it('filters by indexName', async () => {
    await storage.saveVectorIndexSnapshots(
      [makeSnapshot({ id: '1', indexName: 'idx_a' }), makeSnapshot({ id: '2', indexName: 'idx_b' })],
      CONN,
    );

    const fetched = await storage.getVectorIndexSnapshots({ connectionId: CONN, indexName: 'idx_a' });
    expect(fetched).toHaveLength(1);
    expect(fetched[0].indexName).toBe('idx_a');
  });
});
