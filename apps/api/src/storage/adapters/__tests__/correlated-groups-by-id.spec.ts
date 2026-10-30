import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import type {
  StoragePort,
  StoredAnomalyEvent,
  StoredCorrelatedGroup,
} from '../../../common/interfaces/storage-port.interface';

const POSTGRES_DSN =
  process.env.CORRELATED_GROUPS_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

function isReachable(connectionString: string): boolean {
  const { hostname, port } = new URL(connectionString);
  const probe = `
    const socket = require('net').createConnection({ host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT) });
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); process.exit(0); });
    socket.on('timeout', () => { socket.destroy(); process.exit(1); });
    socket.on('error', () => { process.exit(1); });
  `;
  try {
    execFileSync(process.execPath, ['-e', probe], {
      stdio: 'ignore',
      timeout: 3000,
      env: { ...process.env, PROBE_HOST: hostname, PROBE_PORT: port || '5432' },
    });
    return true;
  } catch {
    return false;
  }
}

type AdapterFactory = () => Promise<{ storage: StoragePort; cleanup: () => Promise<void> }>;

const inProcess =
  (make: () => StoragePort): AdapterFactory =>
  async () => {
    const storage = make();
    await storage.initialize();
    return { storage, cleanup: () => storage.close() };
  };

const postgresAdapters: Array<[string, AdapterFactory]> = isReachable(POSTGRES_DSN)
  ? [
      [
        'PostgresAdapter',
        async () => {
          const schema = `correlated_by_id_${randomUUID().replace(/-/g, '')}`;
          const storage = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
          await storage.initialize();
          return {
            storage: storage as StoragePort,
            cleanup: async () => {
              await storage.close();
              const pool = new Pool({ connectionString: POSTGRES_DSN });
              try {
                await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
              } finally {
                await pool.end();
              }
            },
          };
        },
      ],
    ]
  : [];

const adapters: Array<[string, AdapterFactory]> = [
  ['MemoryAdapter', inProcess(() => new MemoryAdapter() as unknown as StoragePort)],
  [
    'SqliteAdapter',
    inProcess(() => new SqliteAdapter({ filepath: ':memory:' }) as unknown as StoragePort),
  ],
  ...postgresAdapters,
];

describe.each<[string, AdapterFactory]>(adapters)(
  'anomaly event upsert (%s)',
  (_name, makeAdapter) => {
    let storage: StoragePort;
    let cleanup: () => Promise<void>;
    const CONN = 'conn-a';
    const ID = randomUUID();
    const CORRELATION_ID = randomUUID();

    const event = (overrides: Partial<StoredAnomalyEvent> = {}): StoredAnomalyEvent => ({
      id: ID,
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

    const correlated = event({
      correlationId: CORRELATION_ID,
      relatedMetrics: ['cluster_state'],
    });
    const preserved = expect.objectContaining({
      correlationId: CORRELATION_ID,
      relatedMetrics: ['cluster_state'],
    });

    beforeEach(async () => {
      ({ storage, cleanup } = await makeAdapter());
    });

    afterEach(async () => {
      await cleanup();
    });

    it('keeps correlation fields when saved again without them', async () => {
      await storage.saveAnomalyEvent(correlated, CONN);
      await storage.saveAnomalyEvent(event(), CONN);

      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(preserved);
    });

    it('keeps correlation fields when batch saved again without them', async () => {
      await storage.saveAnomalyEvents([correlated], CONN);
      await storage.saveAnomalyEvents([event()], CONN);

      const rows = await storage.getAnomalyEvents({ connectionId: CONN });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(preserved);
    });
  },
);

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
