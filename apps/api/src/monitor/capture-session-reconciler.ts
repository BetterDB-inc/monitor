import { Inject, Injectable, Logger } from '@nestjs/common';
import { CaptureNodeSegment } from '@betterdb/shared';
import { StoragePort, StoredCaptureSession } from '../common/interfaces/storage-port.interface';
import { monitorCaptureReconcileOnStartupSchema } from '../config/env.schema';
import { ORPHAN_AGE_MS } from './capture-limits';

const PAGE_SIZE = 1000;
const STARTUP_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
/** Orphans failed in parallel per batch; each costs a stats query and a conditional update. */
const RECONCILE_CONCURRENCY = 8;

/** Storage types several API instances can share; only the age-based sweep is safe there. */
const SHARED_STORAGE_TYPES = new Set(['postgres', 'postgresql', 'turso']);

type OrphanReason = 'api_restart' | 'stale';
export type IsOwned = (sessionId: string) => boolean;
interface AbortFlag {
  aborted: boolean;
}

/**
 * MONITOR_CAPTURE_RECONCILE_ON_STARTUP wins when set. Unset, the startup pass
 * runs only on storage a single instance owns (sqlite, memory): on shared
 * storage this process cannot tell a peer's live capture from an orphan.
 */
export function resolveReconcileOnStartup(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = monitorCaptureReconcileOnStartupSchema.parse(
    env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP,
  );
  if (explicit !== undefined) return explicit;
  const storageType = (env.STORAGE_TYPE ?? 'sqlite').trim().toLowerCase();
  return !SHARED_STORAGE_TYPES.has(storageType);
}

/**
 * Fails capture rows left `running` by a process that no longer owns them
 * (restart, crash, OOM). Never loads chunk bytes. Every write is a
 * compare-and-set on status = 'running', so a row that reached a terminal
 * status in the meantime is never overwritten.
 */
@Injectable()
export class CaptureSessionReconciler {
  private readonly logger = new Logger(CaptureSessionReconciler.name);
  private readonly reconcileOnStartupEnabled = resolveReconcileOnStartup();
  /** Rows started at or after this belong to this process's lifetime, never to a previous one. */
  private readonly bootedAt = Date.now();
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(@Inject('STORAGE_CLIENT') private readonly storage: StoragePort) {}

  /**
   * Never rejects. Gives up after STARTUP_TIMEOUT_MS so readiness is not held
   * hostage by slow storage; the abort flag stops any further writes, and the
   * age-based sweep covers whatever was left.
   */
  async reconcileOnStartup(isOwned: IsOwned): Promise<void> {
    if (!this.reconcileOnStartupEnabled) return;
    const abort: AbortFlag = { aborted: false };
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), STARTUP_TIMEOUT_MS);
      timer.unref();
    });
    const outcome = await Promise.race([
      this.reconcile('api_restart', isOwned, (s) => s.startedAt < this.bootedAt, abort),
      timedOut,
    ]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      abort.aborted = true;
      this.logger.warn(
        `Startup capture reconciliation stopped after ${STARTUP_TIMEOUT_MS} ms; remaining orphans are left to the stale sweep`,
      );
    }
  }

  startSweep(isOwned: IsOwned): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      if (this.sweeping) return; // a slow pass is still running; don't stack them
      this.sweeping = true;
      // reconcile() logs its own failures and never rejects.
      void this.reconcile(
        'stale',
        isOwned,
        (s) => s.startedAt < Date.now() - ORPHAN_AGE_MS,
      ).finally(() => {
        this.sweeping = false;
      });
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Returns how many rows were failed. Never rejects; failures are logged. */
  async reconcile(
    reason: OrphanReason,
    isOwned: IsOwned,
    eligible: (s: StoredCaptureSession) => boolean,
    abort: AbortFlag = { aborted: false },
  ): Promise<number> {
    let count = 0;
    try {
      const running = await this.loadRunning(abort);
      const candidates = running.filter((s) => !isOwned(s.id) && eligible(s));
      for (let i = 0; i < candidates.length && !abort.aborted; i += RECONCILE_CONCURRENCY) {
        const batch = candidates.slice(i, i + RECONCILE_CONCURRENCY);
        const results = await Promise.all(
          batch.map((s) => this.tryFail(s, reason, isOwned, abort)),
        );
        count += results.filter(Boolean).length;
      }
    } catch (err) {
      this.logger.warn(`Capture session reconciliation failed: ${(err as Error).message}`);
    }
    if (count > 0) {
      this.logger.log(`Reconciled ${count} orphaned capture session(s) (${reason})`);
    }
    return count;
  }

  private async loadRunning(abort: AbortFlag): Promise<StoredCaptureSession[]> {
    const running: StoredCaptureSession[] = [];
    for (let offset = 0; !abort.aborted; offset += PAGE_SIZE) {
      const page = await this.storage.getCaptureSessions({
        status: 'running',
        limit: PAGE_SIZE,
        offset,
      });
      running.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    return running;
  }

  private async tryFail(
    s: StoredCaptureSession,
    reason: OrphanReason,
    isOwned: IsOwned,
    abort: AbortFlag,
  ): Promise<boolean> {
    // Re-check just before writing. Ownership of a snapshotted row can only go
    // owned → not owned (it finished); the CAS in failSession handles that case.
    if (abort.aborted || isOwned(s.id)) return false;
    try {
      return await this.failSession(s, reason, abort);
    } catch (err) {
      this.logger.warn(`Failed to reconcile capture session ${s.id}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * False when the pass was aborted while reading chunk stats, or when the row
   * was no longer `running` (CAS miss): someone else finished it.
   */
  private async failSession(
    s: StoredCaptureSession,
    reason: OrphanReason,
    abort: AbortFlag,
  ): Promise<boolean> {
    // CaptureWriter writes byte/line counts only in terminate(), so an orphan
    // still holds the 0 it was inserted with. Recover them from the chunks.
    const stats = await this.storage.getCaptureChunkStats(s.id);
    // The stats read can outlive the startup timeout; write nothing after it.
    if (abort.aborted) return false;
    const endedAt = stats?.lastTs ?? Date.now();
    const segments: CaptureNodeSegment[] | undefined = s.nodeSegments?.map((seg) => {
      if (seg.status !== 'running') return seg; // keep e.g. monitor_open_failed causes
      const node = stats?.byNode[seg.nodeId];
      return {
        ...seg,
        status: 'failed',
        terminationReason: reason,
        endedAt: node?.lastTs ?? endedAt,
        byteCount: Math.max(seg.byteCount, node?.byteCount ?? 0),
        lineCount: Math.max(seg.lineCount, node?.lineCount ?? 0),
      };
    });
    // durationMs is deliberately not written: readers fall back to
    // endedAt - startedAt, so if the owner was alive after all and finalizes
    // later, its endedAt corrects the duration as well.
    return this.storage.updateCaptureSession(
      s.id,
      {
        status: 'failed',
        terminationReason: reason,
        endedAt,
        byteCount: Math.max(s.byteCount, stats?.byteCount ?? 0),
        lineCount: Math.max(s.lineCount, stats?.lineCount ?? 0),
        ...(segments ? { nodeSegments: segments } : {}),
      },
      { ifStatus: 'running' },
    );
  }
}
