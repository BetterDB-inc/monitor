import { randomUUID } from 'crypto';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { StoredCaptureSession } from '../../common/interfaces/storage-port.interface';
import { ORPHAN_AGE_MS } from '../capture-limits';
import { CaptureSessionReconciler } from '../capture-session-reconciler';

const CONN = 'conn-1';
const NONE = (): ReadonlySet<string> => new Set();

function session(overrides: Partial<StoredCaptureSession> = {}): StoredCaptureSession {
  return {
    id: randomUUID(),
    connectionId: CONN,
    status: 'running',
    source: 'manual',
    startedAt: 500,
    byteCount: 111,
    lineCount: 7,
    byteCap: 1000,
    lineCap: 1000,
    ...overrides,
  };
}

async function chunk(
  storage: MemoryAdapter,
  sessionId: string,
  chunkIndex: number,
  lastTs: number,
  nodeId?: string,
): Promise<void> {
  await storage.saveCaptureChunk({
    sessionId,
    chunkIndex,
    bytes: Buffer.from('x'),
    lineCount: 1,
    firstTs: lastTs - 1,
    lastTs,
    nodeId,
  });
}

describe('CaptureSessionReconciler', () => {
  let storage: MemoryAdapter;
  let reconciler: CaptureSessionReconciler;
  const savedEnv = process.env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP;

  beforeEach(async () => {
    delete process.env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP;
    storage = new MemoryAdapter();
    await storage.initialize();
    reconciler = new CaptureSessionReconciler(storage);
  });

  afterEach(() => {
    reconciler.stopSweep();
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (savedEnv === undefined) delete process.env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP;
    else process.env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP = savedEnv;
  });

  it('fails a running orphan using the last chunk time and keeps counts', async () => {
    const s = session();
    await storage.saveCaptureSession(s, CONN);
    await chunk(storage, s.id, 0, 1000);
    await chunk(storage, s.id, 1, 2000);

    await reconciler.reconcileOnStartup(NONE);

    expect(await storage.getCaptureSession(s.id)).toMatchObject({
      status: 'failed',
      terminationReason: 'api_restart',
      endedAt: 2000,
      durationMs: 2000 - 500,
      byteCount: 111,
      lineCount: 7,
    });
    expect(await storage.getCaptureChunks(s.id)).toHaveLength(2);
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

  it('fails running fan-out segments with their own last chunk time', async () => {
    const s = session({
      nodeSegments: [
        { nodeId: 'a', address: 'a:1', status: 'running', byteCount: 1, lineCount: 1 },
        {
          nodeId: 'b',
          address: 'b:1',
          status: 'completed',
          byteCount: 2,
          lineCount: 2,
          endedAt: 1200,
        },
      ],
    });
    await storage.saveCaptureSession(s, CONN);
    await chunk(storage, s.id, 0, 1500, 'a');
    await chunk(storage, s.id, 10_000_000, 1800, 'b');

    await reconciler.reconcileOnStartup(NONE);

    const row = await storage.getCaptureSession(s.id);
    expect(row?.status).toBe('failed');
    expect(row?.endedAt).toBe(1800);
    const [a, b] = row!.nodeSegments!;
    expect(a).toMatchObject({ status: 'failed', terminationReason: 'api_restart', endedAt: 1500 });
    expect(b).toMatchObject({ status: 'completed', endedAt: 1200 });
  });

  it('skips rows this process owns, in both passes', async () => {
    const s = session({ startedAt: Date.now() - 60 * 60_000 });
    await storage.saveCaptureSession(s, CONN);
    const owned = (): ReadonlySet<string> => new Set([s.id]);

    await reconciler.reconcileOnStartup(owned);
    await reconciler.reconcile('stale', owned, (x) => x.startedAt < Date.now() - ORPHAN_AGE_MS);

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
});
