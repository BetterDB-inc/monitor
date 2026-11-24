import { randomUUID } from 'crypto';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { StoredCaptureSession } from '../../common/interfaces/storage-port.interface';
import { ORPHAN_AGE_MS } from '../capture-limits';
import { CaptureSessionReconciler, resolveReconcileOnStartup } from '../capture-session-reconciler';

const CONN = 'conn-1';
const NONE = (): boolean => false;

function session(overrides: Partial<StoredCaptureSession> = {}): StoredCaptureSession {
  return {
    id: randomUUID(),
    connectionId: CONN,
    status: 'running',
    source: 'manual',
    startedAt: 500,
    byteCount: 0,
    lineCount: 0,
    byteCap: 1000,
    lineCap: 1000,
    ...overrides,
  };
}

/** One chunk of `lines` one-byte lines: bytes = 2*lines - 1, writer count = 2*lines. */
async function chunk(
  storage: MemoryAdapter,
  sessionId: string,
  chunkIndex: number,
  lastTs: number,
  nodeId?: string,
  lines = 1,
): Promise<void> {
  await storage.saveCaptureChunk({
    sessionId,
    chunkIndex,
    bytes: Buffer.from(Array(lines).fill('x').join('\n')),
    lineCount: lines,
    firstTs: lastTs - 1,
    lastTs,
    nodeId,
  });
}

const ENV_KEYS = ['MONITOR_CAPTURE_RECONCILE_ON_STARTUP', 'STORAGE_TYPE'] as const;

describe('CaptureSessionReconciler', () => {
  let storage: MemoryAdapter;
  let reconciler: CaptureSessionReconciler;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    storage = new MemoryAdapter();
    await storage.initialize();
    reconciler = new CaptureSessionReconciler(storage);
  });

  afterEach(() => {
    reconciler.stopSweep();
    jest.useRealTimers();
    jest.restoreAllMocks();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('fails a running orphan at the last chunk time and recovers counts from the chunks', async () => {
    const s = session();
    await storage.saveCaptureSession(s, CONN);
    await chunk(storage, s.id, 0, 1000, undefined, 3);
    await chunk(storage, s.id, 1, 2000, undefined, 2);

    await reconciler.reconcileOnStartup(NONE);

    const row = await storage.getCaptureSession(s.id);
    expect(row).toMatchObject({
      status: 'failed',
      terminationReason: 'api_restart',
      endedAt: 2000,
      byteCount: 6 + 4,
      lineCount: 5,
    });
    // Not written: readers derive it from endedAt - startedAt.
    expect(row?.durationMs).toBeUndefined();
    expect(await storage.getCaptureChunks(s.id)).toHaveLength(2);
  });

  it('never lowers counts the row already has', async () => {
    const s = session({ byteCount: 111, lineCount: 7 });
    await storage.saveCaptureSession(s, CONN);
    await chunk(storage, s.id, 0, 1000);
    await reconciler.reconcileOnStartup(NONE);
    expect(await storage.getCaptureSession(s.id)).toMatchObject({ byteCount: 111, lineCount: 7 });
  });

  it('uses now as endedAt when there are no chunks', async () => {
    const s = session();
    await storage.saveCaptureSession(s, CONN);
    const before = Date.now();
    await reconciler.reconcileOnStartup(NONE);
    const row = await storage.getCaptureSession(s.id);
    expect(row?.endedAt).toBeGreaterThanOrEqual(before);
    expect(row?.endedAt).toBeLessThanOrEqual(Date.now());
  });

  it('leaves terminal rows untouched', async () => {
    const rows = (['completed', 'truncated', 'failed', 'skipped'] as const).map((status) =>
      session({ status, endedAt: 900, terminationReason: 'orig' }),
    );
    for (const r of rows) await storage.saveCaptureSession(r, CONN);
    const spy = jest.spyOn(storage, 'updateCaptureSession');

    await reconciler.reconcileOnStartup(NONE);

    expect(spy).not.toHaveBeenCalled();
    for (const r of rows) {
      expect(await storage.getCaptureSession(r.id)).toMatchObject({
        status: r.status,
        terminationReason: 'orig',
      });
    }
  });

  it('does not overwrite a row that finishes between the snapshot and the write', async () => {
    const s = session();
    await storage.saveCaptureSession(s, CONN);
    // The owner finalizes while the reconciler is reading chunk stats.
    jest.spyOn(storage, 'getCaptureChunkStats').mockImplementation(async (id) => {
      await storage.updateCaptureSession(id, {
        status: 'completed',
        endedAt: 4000,
        terminationReason: 'duration',
      });
      return null;
    });

    expect(await reconciler.reconcile('api_restart', NONE, () => true)).toBe(0);
    expect(await storage.getCaptureSession(s.id)).toMatchObject({
      status: 'completed',
      endedAt: 4000,
      terminationReason: 'duration',
    });
  });

  it('fails running fan-out segments with their own chunk time and counts', async () => {
    const s = session({
      nodeSegments: [
        { nodeId: 'a', address: 'a:1', status: 'running', byteCount: 0, lineCount: 0 },
        {
          nodeId: 'b',
          address: 'b:1',
          status: 'completed',
          byteCount: 2,
          lineCount: 1,
          endedAt: 1200,
        },
        {
          nodeId: 'c',
          address: 'c:1',
          status: 'failed',
          byteCount: 0,
          lineCount: 0,
          endedAt: 600,
          terminationReason: 'monitor_open_failed: NOPERM',
        },
      ],
    });
    await storage.saveCaptureSession(s, CONN);
    await chunk(storage, s.id, 0, 1500, 'a', 4);
    await chunk(storage, s.id, 10_000_000, 1200, 'b');

    await reconciler.reconcileOnStartup(NONE);

    const row = await storage.getCaptureSession(s.id);
    expect(row).toMatchObject({ status: 'failed', endedAt: 1500, byteCount: 8 + 2, lineCount: 5 });
    const [a, b, c] = row!.nodeSegments!;
    expect(a).toMatchObject({
      status: 'failed',
      terminationReason: 'api_restart',
      endedAt: 1500,
      byteCount: 8,
      lineCount: 4,
    });
    expect(b).toMatchObject({ status: 'completed', endedAt: 1200 });
    expect(c).toMatchObject({ status: 'failed', terminationReason: 'monitor_open_failed: NOPERM' });
  });

  it('skips rows this process owns, in both passes', async () => {
    const s = session({ startedAt: Date.now() - 60 * 60_000 });
    await storage.saveCaptureSession(s, CONN);
    const owned = (id: string): boolean => id === s.id;

    await reconciler.reconcileOnStartup(owned);
    await reconciler.reconcile('stale', owned, (x) => x.startedAt < Date.now() - ORPHAN_AGE_MS);

    expect((await storage.getCaptureSession(s.id))?.status).toBe('running');
  });

  it('startup pass skips rows started after this process booted', async () => {
    const s = session({ startedAt: Date.now() + 60_000 });
    await storage.saveCaptureSession(s, CONN);
    await reconciler.reconcileOnStartup(NONE);
    expect((await storage.getCaptureSession(s.id))?.status).toBe('running');
  });

  it('sweep only fails rows older than the orphan age', async () => {
    jest.useFakeTimers();
    const now = Date.now();
    const young = session({ startedAt: now - 10 * 60_000 });
    const old = session({ startedAt: now - 18 * 60_000 });
    await storage.saveCaptureSession(young, CONN);
    await storage.saveCaptureSession(old, CONN);

    reconciler.startSweep(NONE);
    await jest.advanceTimersByTimeAsync(60_000);

    expect((await storage.getCaptureSession(young.id))?.status).toBe('running');
    expect(await storage.getCaptureSession(old.id)).toMatchObject({
      status: 'failed',
      terminationReason: 'stale',
    });
  });

  it('does not throw when storage fails, and logs a warning', async () => {
    jest.spyOn(storage, 'getCaptureSessions').mockRejectedValue(new Error('db down'));
    const warn = jest
      .spyOn((reconciler as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    await expect(reconciler.reconcileOnStartup(NONE)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('gives up after the startup timeout and writes nothing afterwards', async () => {
    jest.useFakeTimers();
    const s = session();
    await storage.saveCaptureSession(s, CONN);
    let release!: (rows: StoredCaptureSession[]) => void;
    jest.spyOn(storage, 'getCaptureSessions').mockReturnValue(new Promise((r) => (release = r)));
    const update = jest.spyOn(storage, 'updateCaptureSession');
    jest
      .spyOn((reconciler as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    const done = reconciler.reconcileOnStartup(NONE);
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(done).resolves.toBeUndefined();

    release([s]); // storage answers late
    await jest.advanceTimersByTimeAsync(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('is idempotent', async () => {
    const a = session();
    const b = session();
    await storage.saveCaptureSession(a, CONN);
    await storage.saveCaptureSession(b, CONN);
    const spy = jest.spyOn(storage, 'updateCaptureSession');

    await reconciler.reconcileOnStartup(NONE);
    await reconciler.reconcileOnStartup(NONE);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does nothing at startup when MONITOR_CAPTURE_RECONCILE_ON_STARTUP=false', async () => {
    process.env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP = 'false';
    const off = new CaptureSessionReconciler(storage);
    const s = session();
    await storage.saveCaptureSession(s, CONN);
    await off.reconcileOnStartup(NONE);
    expect((await storage.getCaptureSession(s.id))?.status).toBe('running');
  });

  it('does nothing at startup on postgres unless explicitly enabled', async () => {
    process.env.STORAGE_TYPE = 'postgres';
    const s = session();
    await storage.saveCaptureSession(s, CONN);
    await new CaptureSessionReconciler(storage).reconcileOnStartup(NONE);
    expect((await storage.getCaptureSession(s.id))?.status).toBe('running');

    process.env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP = 'true';
    await new CaptureSessionReconciler(storage).reconcileOnStartup(NONE);
    expect((await storage.getCaptureSession(s.id))?.status).toBe('failed');
  });

  describe('resolveReconcileOnStartup', () => {
    it.each([
      [{}, true],
      [{ STORAGE_TYPE: 'sqlite' }, true],
      [{ STORAGE_TYPE: 'memory' }, true],
      [{ STORAGE_TYPE: 'postgres' }, false],
      [{ STORAGE_TYPE: 'postgresql' }, false],
      [{ STORAGE_TYPE: 'turso' }, false],
      [{ STORAGE_TYPE: 'postgres', MONITOR_CAPTURE_RECONCILE_ON_STARTUP: 'true' }, true],
      [{ STORAGE_TYPE: 'sqlite', MONITOR_CAPTURE_RECONCILE_ON_STARTUP: ' Off ' }, false],
      [{ STORAGE_TYPE: 'postgres', MONITOR_CAPTURE_RECONCILE_ON_STARTUP: '' }, false],
    ])('%p → %p', (env, expected) => {
      expect(resolveReconcileOnStartup(env as NodeJS.ProcessEnv)).toBe(expected);
    });
  });
});
