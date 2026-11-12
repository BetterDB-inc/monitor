import { adapters } from './anomaly-storage-adapters';
import { PostgresAdapter } from '../postgres.adapter';

const SCOPE_INDEXES = ['idx_anomaly_events_scope', 'idx_correlated_groups_scope'];
const makePostgres = adapters.find(([name]) => name === 'PostgresAdapter')?.[1];

(makePostgres ? describe : describe.skip)('Postgres correlation scope indexes', () => {
  const adapterInternals = PostgresAdapter.prototype as unknown as Record<
    string,
    () => Promise<boolean>
  >;

  const validIndexes = async (storage: unknown): Promise<Record<string, boolean>> => {
    const { pool } = storage as { pool: { query: Function } };
    const { rows } = await pool.query(
      `SELECT c.relname, i.indisvalid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = ANY($1) AND n.nspname = current_schema()`,
      [SCOPE_INDEXES],
    );
    return Object.fromEntries(rows.map((r: { relname: string; indisvalid: boolean }) => [r.relname, r.indisvalid]));
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds them after startup', async () => {
    const { storage, cleanup } = await makePostgres!();
    try {
      await (storage as unknown as { indexBuild: Promise<void> }).indexBuild;

      expect(await validIndexes(storage)).toEqual({
        idx_anomaly_events_scope: true,
        idx_correlated_groups_scope: true,
      });
    } finally {
      await cleanup();
    }
  });

  it('leaves them out of the schema transaction', async () => {
    jest.spyOn(adapterInternals, 'ensureIndexConcurrently').mockResolvedValue(true);
    const { storage, cleanup } = await makePostgres!();
    try {
      await (storage as unknown as { indexBuild: Promise<void> }).indexBuild;

      expect(await validIndexes(storage)).toEqual({});
      expect(adapterInternals.ensureIndexConcurrently).toHaveBeenCalledWith(
        expect.anything(),
        'idx_anomaly_events_scope',
        'anomaly_events',
        'scope_id, timestamp DESC',
      );
      expect(adapterInternals.ensureIndexConcurrently).toHaveBeenCalledWith(
        expect.anything(),
        'idx_correlated_groups_scope',
        'correlated_anomaly_groups',
        'scope_id, timestamp DESC',
      );
    } finally {
      await cleanup();
    }
  });
});
