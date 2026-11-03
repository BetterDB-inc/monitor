import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteAdapter } from '../sqlite.adapter';
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
    const db = new Database(dbPath);
    db.exec('UPDATE anomaly_events SET kind = NULL');
    db.close();

    const kinds = Object.fromEntries((await reopen()).map((r) => [r.id, r.kind]));

    expect(kinds).toEqual({
      [sustained]: 'sustained_degradation',
      [upgrade]: 'upgrade_regression',
      [other]: undefined,
    });
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
