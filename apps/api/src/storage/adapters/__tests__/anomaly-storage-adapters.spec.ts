import { Pool } from 'pg';
import { adapters } from './anomaly-storage-adapters';
import { PostgresAdapter } from '../postgres.adapter';

const postgres = adapters.find(([name]) => name === 'PostgresAdapter');
const POSTGRES_DSN =
  process.env.ANOMALY_STORAGE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

(postgres ? describe : describe.skip)('Postgres adapter factory', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('drops the schema and rethrows when initialize fails', async () => {
    const original = PostgresAdapter.prototype.initialize;
    let schema = '';
    jest.spyOn(PostgresAdapter.prototype, 'initialize').mockImplementationOnce(async function (
      this: PostgresAdapter,
    ) {
      schema = (this as unknown as { config: { schema: string } }).config.schema;
      await original.call(this);
      throw new Error('initialize failed');
    });

    await expect(postgres![1]()).rejects.toThrow('initialize failed');

    const pool = new Pool({ connectionString: POSTGRES_DSN });
    try {
      const { rows } = await pool.query(
        'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
        [schema],
      );
      expect(schema).not.toBe('');
      expect(rows).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
