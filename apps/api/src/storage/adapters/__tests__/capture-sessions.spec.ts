import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
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
});
