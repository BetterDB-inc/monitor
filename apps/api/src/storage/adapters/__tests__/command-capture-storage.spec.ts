import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MemoryAdapter } from '../memory.adapter';
import { SqliteAdapter } from '../sqlite.adapter';
import type {
  StoredCommandCaptureSession,
  StoredCommandCaptureRecord,
} from '../../../common/interfaces/storage-port.interface';

const CONNECTION_ID = 'conn-test';

function makeSession(overrides: Partial<StoredCommandCaptureSession> = {}): StoredCommandCaptureSession {
  const now = Date.now();
  return {
    id: randomUUID(),
    connectionId: CONNECTION_ID,
    status: 'active',
    startedAt: now,
    durationMs: 60_000,
    expiresAt: now + 60_000,
    commandCount: 0,
    ...overrides,
  };
}

function makeRecords(sessionId: string, count: number, tsBase = Date.now()): StoredCommandCaptureRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId,
    connectionId: CONNECTION_ID,
    wrapperConnectionId: 'wrapper-1',
    name: 'SET',
    args: [`key${i}`, `val${i}`],
    ts: tsBase + i,
  }));
}

describe.each([
  ['MemoryAdapter', () => {
    const adapter = new MemoryAdapter();
    return { adapter, cleanup: async () => {} };
  }],
  ['SqliteAdapter', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-capture-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    const adapter = new SqliteAdapter({ filepath: dbPath });
    return {
      adapter,
      cleanup: async () => {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
      },
    };
  }],
])('%s: command capture storage', (_name, factory) => {
  let adapter: MemoryAdapter | SqliteAdapter;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const ctx = factory();
    adapter = ctx.adapter;
    cleanup = ctx.cleanup;
    await adapter.initialize();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('saves and retrieves a session', async () => {
    const session = makeSession();
    await adapter.saveCommandCaptureSession(session);
    const got = await adapter.getCommandCaptureSession(session.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(session.id);
    expect(got!.connectionId).toBe(CONNECTION_ID);
    expect(got!.status).toBe('active');
  });

  it('queries sessions by connectionId and status', async () => {
    const s1 = makeSession({ connectionId: 'q-conn', status: 'active' });
    const s2 = makeSession({ connectionId: 'q-conn', status: 'stopped' });
    await adapter.saveCommandCaptureSession(s1);
    await adapter.saveCommandCaptureSession(s2);

    const active = await adapter.getCommandCaptureSessions({ connectionId: 'q-conn', status: 'active' });
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(s1.id);
  });

  it('updates session fields', async () => {
    const session = makeSession();
    await adapter.saveCommandCaptureSession(session);
    await adapter.updateCommandCaptureSession(session.id, { status: 'stopped', stoppedAt: Date.now(), commandCount: 42 });
    const got = await adapter.getCommandCaptureSession(session.id);
    expect(got!.status).toBe('stopped');
    expect(got!.commandCount).toBe(42);
    expect(got!.stoppedAt).toBeDefined();
  });

  it('bulk writes and reads back records', async () => {
    const session = makeSession();
    await adapter.saveCommandCaptureSession(session);
    const records = makeRecords(session.id, 100);
    const saved = await adapter.saveCommandCaptureRecords(records);
    expect(saved).toBe(100);
  });

  it('prunes records by timestamp', async () => {
    const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const session = makeSession({ startedAt: oldTs, expiresAt: oldTs + 60_000 });
    await adapter.saveCommandCaptureSession(session);

    const oldRecords = makeRecords(session.id, 5, oldTs);
    const newRecords = makeRecords(session.id, 3, Date.now());
    await adapter.saveCommandCaptureRecords([...oldRecords, ...newRecords]);

    const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000; // 5 days ago
    const pruned = await adapter.pruneOldCommandCaptureRecords(cutoff);
    expect(pruned).toBe(5);
  });

  it('prunes sessions by timestamp (non-active only)', async () => {
    const oldTs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const old1 = makeSession({ startedAt: oldTs, status: 'stopped', connectionId: 'prune-conn' });
    const old2 = makeSession({ startedAt: oldTs, status: 'active', connectionId: 'prune-conn' }); // active = kept
    const recent = makeSession({ status: 'stopped', connectionId: 'prune-conn' }); // recent = kept
    await adapter.saveCommandCaptureSession(old1);
    await adapter.saveCommandCaptureSession(old2);
    await adapter.saveCommandCaptureSession(recent);

    const cutoff = Date.now() - 5 * 24 * 60 * 60 * 1000;
    const pruned = await adapter.pruneOldCommandCaptureSessions(cutoff);
    expect(pruned).toBe(1); // only old1
  });
});
