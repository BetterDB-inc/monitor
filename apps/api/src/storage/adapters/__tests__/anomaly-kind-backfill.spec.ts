import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../sqlite.adapter';
import { PostgresAdapter } from '../postgres.adapter';
import { adapters } from './anomaly-storage-adapters';
import type { StoredAnomalyEvent } from '../../../common/interfaces/storage-port.interface';

describe('SqliteAdapter anomaly kind backfill', () => {
  const CONN = 'conn-a';
  let dbPath: string;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anomaly-kind-'));
    dbPath = path.join(dir, 'anomaly.db');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  const forgetKinds = () => {
    const db = new Database(dbPath);
    db.exec('ALTER TABLE anomaly_events DROP COLUMN kind');
    db.exec('UPDATE anomaly_events SET replica_addr = NULL');
    db.close();
  };

  const event = (id: string, metricType: string, message: string): StoredAnomalyEvent => ({
    id,
    timestamp: 1_700_000_000_000,
    metricType,
    anomalyType: 'spike',
    severity: 'warning',
    value: 900,
    baseline: 300,
    stdDev: 0,
    zScore: 0,
    threshold: 3,
    message,
    resolved: true,
  });

  async function reopen(): Promise<StoredAnomalyEvent[]> {
    const adapter = new SqliteAdapter({ filepath: dbPath });
    await adapter.initialize();
    try {
      return await adapter.getAnomalyEvents({ connectionId: CONN });
    } finally {
      await adapter.close();
    }
  }

  it('labels legacy command_p99 rows from their message and leaves other rows alone', async () => {
    const sustained = randomUUID();
    const upgrade = randomUUID();
    const other = randomUUID();
    const seeded = new SqliteAdapter({ filepath: dbPath });
    await seeded.initialize();
    await seeded.saveAnomalyEvents(
      [
        event(sustained, 'command_p99', 'Sustained P99 latency degradation: GET 2x.'),
        event(upgrade, 'command_p99', 'P99 latency regression after upgrade 8.0 -> 9.0: GET 2x.'),
        event(other, 'memory_used', 'Sustained P99 latency degradation lookalike'),
      ],
      CONN,
    );
    await seeded.close();
    forgetKinds();

    const kinds = Object.fromEntries((await reopen()).map((r) => [r.id, r.kind]));

    expect(kinds).toEqual({
      [sustained]: 'sustained_degradation',
      [upgrade]: 'upgrade_regression',
      [other]: undefined,
    });
  });

  it('fills the replica of legacy resync rows from their message', async () => {
    const resync = randomUUID();
    const unparsable = randomUUID();
    const seeded = new SqliteAdapter({ filepath: dbPath });
    await seeded.initialize();
    await seeded.saveAnomalyEvents(
      [
        event(resync, 'resync_escalation', 'Replica 10.0.0.2:6379 came back after 5s.'),
        event(unparsable, 'resync_escalation', 'Replica 10.0.0.3:6379'),
      ],
      CONN,
    );
    await seeded.close();
    forgetKinds();

    const replicas = Object.fromEntries((await reopen()).map((r) => [r.id, r.replicaAddr]));

    expect(replicas).toEqual({ [resync]: '10.0.0.2:6379', [unparsable]: undefined });
  });

  it('runs only when the kind column is added', async () => {
    const id = randomUUID();
    const seeded = new SqliteAdapter({ filepath: dbPath });
    await seeded.initialize();
    await seeded.saveAnomalyEvent(event(id, 'command_p99', 'P99 regression: GET 2x.'), CONN);
    await seeded.close();

    const [row] = await reopen();

    expect(row.kind).toBeUndefined();
  });

  it('keeps a kind that is already set', async () => {
    const id = randomUUID();
    const seeded = new SqliteAdapter({ filepath: dbPath });
    await seeded.initialize();
    await seeded.saveAnomalyEvent(
      {
        ...event(id, 'command_p99', 'Sustained P99 latency degradation: GET 2x.'),
        kind: 'upgrade_regression',
      },
      CONN,
    );
    await seeded.close();

    const [row] = await reopen();

    expect(row.kind).toBe('upgrade_regression');
  });
});

const postgresFactory = adapters.find(([name]) => name === 'PostgresAdapter');
const POSTGRES_DSN =
  process.env.ANOMALY_STORAGE_POSTGRES_TEST_DSN ??
  'postgres://betterdb:devpassword@localhost:5433/betterdb';

(postgresFactory ? describe : describe.skip)('PostgresAdapter anomaly kind backfill', () => {
  const CONN = 'conn-a';
  const schema = `anomaly_kind_${randomUUID().replace(/-/g, '')}`;
  const pool = new Pool({ connectionString: POSTGRES_DSN });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  const open = async () => {
    const adapter = new PostgresAdapter({ connectionString: POSTGRES_DSN, schema });
    await adapter.initialize();
    return adapter;
  };

  it('labels legacy rows once, after the schema is set up', async () => {
    const sustained = randomUUID();
    const upgrade = randomUUID();
    const resync = randomUUID();
    const base = {
      timestamp: 1_700_000_000_000,
      anomalyType: 'spike',
      severity: 'warning',
      value: 900,
      baseline: 300,
      stdDev: 0,
      zScore: 0,
      threshold: 3,
      resolved: true,
    };
    const seeded = await open();
    await seeded.saveAnomalyEvents(
      [
        {
          ...base,
          id: sustained,
          metricType: 'command_p99',
          message: 'Sustained P99 latency degradation: GET 2x.',
        },
        {
          ...base,
          id: upgrade,
          metricType: 'command_p99',
          message: 'sustained p99 latency degradation: GET 2x.',
        },
        {
          ...base,
          id: resync,
          metricType: 'resync_escalation',
          message: 'Replica 10.0.0.2:6379 came back after 5s.',
        },
      ],
      CONN,
    );
    await seeded.close();
    await pool.query(`ALTER TABLE ${schema}.anomaly_events DROP COLUMN kind`);
    await pool.query(`UPDATE ${schema}.anomaly_events SET replica_addr = NULL`);

    const reopened = await open();
    const rows = await reopened.getAnomalyEvents({ connectionId: CONN });
    await reopened.close();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId[sustained].kind).toBe('sustained_degradation');
    expect(byId[upgrade].kind).toBe('upgrade_regression');
    expect(byId[resync].replicaAddr).toBe('10.0.0.2:6379');
  });
});
