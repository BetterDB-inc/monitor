import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { CaptureCounterSnapshots } from '@betterdb/shared';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import { StoredCaptureSession } from '../../../common/interfaces/storage-port.interface';

const CONNECTION_ID = 'conn-test';

function makeSession(overrides: Partial<StoredCaptureSession> = {}): StoredCaptureSession {
  return {
    id: randomUUID(),
    connectionId: CONNECTION_ID,
    status: 'completed',
    source: 'manual',
    requestedBy: 'tester',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_005_000,
    durationMs: 5000,
    byteCount: 1024,
    lineCount: 42,
    byteCap: 50 * 1024 * 1024,
    lineCap: 5_000_000,
    ...overrides,
  };
}

describe.each([
  ['SqliteAdapter', () => Promise.resolve(new SqliteAdapter({
    filepath: path.join(os.tmpdir(), `capture-sessions-${randomUUID()}.db`),
  }))],
  ['MemoryAdapter', () => Promise.resolve(new MemoryAdapter())],
])('Capture session storage (%s)', (_label, makeAdapter) => {
  let storage: SqliteAdapter | MemoryAdapter;
  let dbPath: string | null = null;

  beforeEach(async () => {
    storage = await makeAdapter();
    if (storage instanceof SqliteAdapter) {
      dbPath = (storage as unknown as { config: { filepath: string } }).config.filepath;
    }
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
    if (dbPath && fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    dbPath = null;
  });

  it('returns an empty list when no sessions exist', async () => {
    expect(await storage.getCaptureSessions()).toEqual([]);
  });

  it('round-trips a session through save and getById', async () => {
    const session = makeSession();
    const id = await storage.saveCaptureSession(session, CONNECTION_ID);
    expect(id).toBe(session.id);

    const fetched = await storage.getCaptureSession(session.id);
    expect(fetched).toEqual(session);
  });

  it('returns null when the session does not exist', async () => {
    expect(await storage.getCaptureSession(randomUUID())).toBeNull();
  });

  it('lists sessions filtered by connectionId, status, and source', async () => {
    const a = makeSession({ status: 'completed', source: 'manual', startedAt: 1000 });
    const b = makeSession({ status: 'truncated', source: 'manual', startedAt: 2000 });
    const c = makeSession({
      status: 'completed',
      source: 'trigger',
      startedAt: 3000,
      connectionId: 'conn-other',
    });

    await storage.saveCaptureSession(a, CONNECTION_ID);
    await storage.saveCaptureSession(b, CONNECTION_ID);
    await storage.saveCaptureSession(c, 'conn-other');

    const all = await storage.getCaptureSessions();
    expect(all.map((s) => s.id)).toEqual([c.id, b.id, a.id]); // DESC by startedAt

    expect(await storage.getCaptureSessions({ connectionId: CONNECTION_ID })).toHaveLength(2);
    expect(await storage.getCaptureSessions({ status: 'truncated' })).toHaveLength(1);
    expect(await storage.getCaptureSessions({ source: 'trigger' })).toHaveLength(1);
    expect(
      await storage.getCaptureSessions({ startedAfter: 1500, startedBefore: 2500 }),
    ).toHaveLength(1);
  });

  it('respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await storage.saveCaptureSession(
        makeSession({ startedAt: 1000 + i }),
        CONNECTION_ID,
      );
    }

    const page1 = await storage.getCaptureSessions({ limit: 2, offset: 0 });
    const page2 = await storage.getCaptureSessions({ limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0].startedAt).toBeGreaterThan(page2[0].startedAt);
  });

  it('updateCaptureSession applies a partial patch', async () => {
    const session = makeSession({ status: 'running', endedAt: undefined, byteCount: 0, lineCount: 0 });
    await storage.saveCaptureSession(session, CONNECTION_ID);

    const updated = await storage.updateCaptureSession(session.id, {
      status: 'completed',
      endedAt: 1_700_000_010_000,
      durationMs: 10_000,
      byteCount: 4096,
      lineCount: 100,
      terminationReason: 'manual_stop',
    });
    expect(updated).toBe(true);

    const fetched = await storage.getCaptureSession(session.id);
    expect(fetched).toMatchObject({
      status: 'completed',
      endedAt: 1_700_000_010_000,
      durationMs: 10_000,
      byteCount: 4096,
      lineCount: 100,
      terminationReason: 'manual_stop',
    });
  });

  describe('counterSnapshots', () => {
    const SINGLE: CaptureCounterSnapshots = {
      version: 1,
      nodes: [
        {
          start: { capturedAt: 1_700_000_000_000, counters: { total_commands_processed: 10 } },
          end: { capturedAt: 1_700_000_005_000, counters: { total_commands_processed: 30 } },
        },
      ],
    };
    const FAN_OUT: CaptureCounterSnapshots = {
      version: 1,
      nodes: [
        {
          nodeId: 'A',
          address: 'h1:6379',
          start: { capturedAt: 1, counters: { evicted_keys: 0 } },
          end: { capturedAt: 2, counters: { evicted_keys: 3 } },
        },
        { nodeId: 'B', address: 'h2:6379', start: null, end: null, startError: 'timeout', endError: 'no_end_sample' },
      ],
    };

    it('round-trips counterSnapshots through save/get', async () => {
      for (const counterSnapshots of [SINGLE, FAN_OUT]) {
        const session = makeSession({ counterSnapshots });
        await storage.saveCaptureSession(session, CONNECTION_ID);
        expect((await storage.getCaptureSession(session.id))?.counterSnapshots).toEqual(
          counterSnapshots,
        );
      }
    });

    it('updateCaptureSession writes counterSnapshots and leaves other fields intact', async () => {
      const session = makeSession({ status: 'running', endedAt: undefined, lineCount: 7 });
      await storage.saveCaptureSession(session, CONNECTION_ID);

      await storage.updateCaptureSession(session.id, {
        status: 'completed',
        counterSnapshots: FAN_OUT,
      });

      const fetched = await storage.getCaptureSession(session.id);
      expect(fetched?.counterSnapshots).toEqual(FAN_OUT);
      expect(fetched).toMatchObject({ status: 'completed', lineCount: 7, byteCap: session.byteCap });
    });

    it('reads sessions without counterSnapshots back as undefined', async () => {
      const session = makeSession();
      await storage.saveCaptureSession(session, CONNECTION_ID);
      expect((await storage.getCaptureSession(session.id))?.counterSnapshots).toBeUndefined();
    });

    it('carries counterSnapshots on getCaptureSessions list rows', async () => {
      const session = makeSession({ counterSnapshots: SINGLE });
      await storage.saveCaptureSession(session, CONNECTION_ID);
      const rows = await storage.getCaptureSessions({ connectionId: CONNECTION_ID });
      expect(rows[0].counterSnapshots).toEqual(SINGLE);
    });
  });

  it('updateCaptureSession returns false for an unknown id', async () => {
    expect(await storage.updateCaptureSession(randomUUID(), { status: 'completed' })).toBe(false);
  });

  it('saveCaptureChunk + getCaptureChunks round-trip preserves bytes and order', async () => {
    const session = makeSession();
    await storage.saveCaptureSession(session, CONNECTION_ID);

    await storage.saveCaptureChunk({
      sessionId: session.id,
      chunkIndex: 0,
      bytes: Buffer.from('chunk-0-content', 'utf-8'),
      lineCount: 3,
      firstTs: 1000,
      lastTs: 1500,
    });
    await storage.saveCaptureChunk({
      sessionId: session.id,
      chunkIndex: 1,
      bytes: Buffer.from('chunk-1-content', 'utf-8'),
      lineCount: 2,
      firstTs: 2000,
      lastTs: 2500,
    });

    const chunks = await storage.getCaptureChunks(session.id);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
    expect(chunks[0].bytes.toString('utf-8')).toBe('chunk-0-content');
    expect(chunks[1].bytes.toString('utf-8')).toBe('chunk-1-content');
    expect(chunks[0].lineCount).toBe(3);
    expect(chunks[1].lineCount).toBe(2);
  });

  it('getCaptureChunks returns empty for unknown session', async () => {
    expect(await storage.getCaptureChunks(randomUUID())).toEqual([]);
  });

  describe('data-retention prune hooks', () => {
    const NOW = 2_000_000_000_000;
    const EIGHT_DAYS_AGO = NOW - 8 * 24 * 60 * 60 * 1000;
    const TWO_DAYS_AGO = NOW - 2 * 24 * 60 * 60 * 1000;
    const SEVEN_DAY_CUTOFF = NOW - 7 * 24 * 60 * 60 * 1000;

    it('pruneOldCaptureSessions deletes ended sessions older than the cutoff', async () => {
      const old = makeSession({
        id: randomUUID(),
        startedAt: EIGHT_DAYS_AGO,
        endedAt: EIGHT_DAYS_AGO + 1000,
      });
      const recent = makeSession({
        id: randomUUID(),
        startedAt: TWO_DAYS_AGO,
        endedAt: TWO_DAYS_AGO + 1000,
      });
      await storage.saveCaptureSession(old, CONNECTION_ID);
      await storage.saveCaptureSession(recent, CONNECTION_ID);

      const pruned = await storage.pruneOldCaptureSessions(SEVEN_DAY_CUTOFF);
      expect(pruned).toBe(1);
      expect(await storage.getCaptureSession(old.id)).toBeNull();
      expect(await storage.getCaptureSession(recent.id)).not.toBeNull();
    });

    it('pruneOldCaptureSessions does not touch running sessions even when older than the cutoff', async () => {
      const running = makeSession({
        id: randomUUID(),
        status: 'running',
        startedAt: EIGHT_DAYS_AGO,
        endedAt: undefined,
        durationMs: undefined,
      });
      await storage.saveCaptureSession(running, CONNECTION_ID);
      const pruned = await storage.pruneOldCaptureSessions(SEVEN_DAY_CUTOFF);
      expect(pruned).toBe(0);
      expect(await storage.getCaptureSession(running.id)).not.toBeNull();
    });

    it('pruneOldCaptureChunks deletes chunks whose lastTs is below the cutoff', async () => {
      const session = makeSession({
        id: randomUUID(),
        startedAt: EIGHT_DAYS_AGO,
        endedAt: TWO_DAYS_AGO + 1000,
      });
      await storage.saveCaptureSession(session, CONNECTION_ID);
      const sessionId = session.id;
      await storage.saveCaptureChunk({
        sessionId,
        chunkIndex: 0,
        bytes: Buffer.from('old', 'utf-8'),
        lineCount: 1,
        firstTs: EIGHT_DAYS_AGO,
        lastTs: EIGHT_DAYS_AGO + 1000,
      });
      await storage.saveCaptureChunk({
        sessionId,
        chunkIndex: 1,
        bytes: Buffer.from('recent', 'utf-8'),
        lineCount: 1,
        firstTs: TWO_DAYS_AGO,
        lastTs: TWO_DAYS_AGO + 1000,
      });
      const pruned = await storage.pruneOldCaptureChunks(SEVEN_DAY_CUTOFF);
      expect(pruned).toBe(1);
      const remaining = await storage.getCaptureChunks(sessionId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].chunkIndex).toBe(1);
    });

    it('pruneOldCaptureTriggers deletes terminal triggers older than cutoff and preserves active ones', async () => {
      const fired = {
        id: randomUUID(),
        connectionId: CONNECTION_ID,
        metricType: 'connections',
        anomalyType: 'spike',
        expiresAt: EIGHT_DAYS_AGO + 60_000,
        createdAt: EIGHT_DAYS_AGO,
        status: 'fired' as const,
        firedAt: EIGHT_DAYS_AGO + 30_000,
        firedSessionId: randomUUID(),
      };
      const stillConfigured = {
        id: randomUUID(),
        connectionId: CONNECTION_ID,
        metricType: 'memory_used',
        anomalyType: 'spike',
        expiresAt: NOW + 24 * 60 * 60 * 1000,
        createdAt: EIGHT_DAYS_AGO,
        status: 'configured' as const,
      };
      await storage.saveCaptureTrigger(fired);
      await storage.saveCaptureTrigger(stillConfigured);

      const pruned = await storage.pruneOldCaptureTriggers(SEVEN_DAY_CUTOFF);
      expect(pruned).toBe(1);
      expect(await storage.getCaptureTrigger(fired.id)).toBeNull();
      expect(await storage.getCaptureTrigger(stillConfigured.id)).not.toBeNull();
    });

    it('pruneOldScheduledCaptures deletes disabled rows older than cutoff and preserves enabled ones', async () => {
      const disabled = {
        id: randomUUID(),
        connectionId: CONNECTION_ID,
        intervalSeconds: 60,
        durationMs: 5000,
        status: 'disabled' as const,
        createdAt: EIGHT_DAYS_AGO,
      };
      const enabled = {
        id: randomUUID(),
        connectionId: CONNECTION_ID,
        intervalSeconds: 60,
        durationMs: 5000,
        status: 'enabled' as const,
        createdAt: EIGHT_DAYS_AGO,
      };
      await storage.saveScheduledCapture(disabled);
      await storage.saveScheduledCapture(enabled);

      const pruned = await storage.pruneOldScheduledCaptures(SEVEN_DAY_CUTOFF);
      expect(pruned).toBe(1);
      expect(await storage.getScheduledCapture(disabled.id)).toBeNull();
      expect(await storage.getScheduledCapture(enabled.id)).not.toBeNull();
    });
  });
});

describe('Capture session storage (SqliteAdapter counter_snapshots column)', () => {
  const files: string[] = [];

  function tempDb(): string {
    const filepath = path.join(os.tmpdir(), `capture-sessions-counters-${randomUUID()}.db`);
    files.push(filepath);
    return filepath;
  }

  afterEach(() => {
    for (const file of files.splice(0)) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });

  it('migrates a legacy capture_sessions table', async () => {
    const filepath = tempDb();
    const raw = new Database(filepath);
    raw.exec(`
      CREATE TABLE capture_sessions (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running','completed','truncated','failed','skipped')),
        source TEXT NOT NULL CHECK (source IN ('manual','trigger','schedule')),
        trigger_id TEXT,
        schedule_id TEXT,
        requested_by TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        duration_ms INTEGER,
        byte_count INTEGER NOT NULL DEFAULT 0,
        line_count INTEGER NOT NULL DEFAULT 0,
        byte_cap INTEGER NOT NULL,
        line_cap INTEGER NOT NULL,
        termination_reason TEXT,
        target_node TEXT,
        node_segments TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      );
    `);
    raw
      .prepare(
        `INSERT INTO capture_sessions (id, connection_id, status, source, started_at, byte_cap, line_cap)
         VALUES ('legacy', ?, 'completed', 'manual', 1700000000000, 1000, 1000)`,
      )
      .run(CONNECTION_ID);
    raw.close();

    const storage = new SqliteAdapter({ filepath });
    await storage.initialize();
    try {
      const db = (storage as unknown as { db: Database.Database }).db;
      const cols = db.prepare('PRAGMA table_info(capture_sessions)').all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain('counter_snapshots');

      const legacy = await storage.getCaptureSession('legacy');
      expect(legacy).not.toBeNull();
      expect(legacy?.counterSnapshots).toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it('decodes a corrupted counter_snapshots value to undefined', async () => {
    const storage = new SqliteAdapter({ filepath: tempDb() });
    await storage.initialize();
    try {
      const session = makeSession({
        counterSnapshots: { version: 1, nodes: [{ start: null, end: null }] },
      });
      await storage.saveCaptureSession(session, CONNECTION_ID);
      (storage as unknown as { db: Database.Database }).db
        .prepare(`UPDATE capture_sessions SET counter_snapshots = '{bad'`)
        .run();

      const fetched = await storage.getCaptureSession(session.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.counterSnapshots).toBeUndefined();
    } finally {
      await storage.close();
    }
  });
});
