import { Inject, Injectable, Logger } from '@nestjs/common';
import { CaptureNodeSegment } from '@betterdb/shared';
import { StoragePort, StoredCaptureSession } from '../common/interfaces/storage-port.interface';
import { isNegativeEnvValue } from '../common/utils/env-bool';
import { withTimeout } from '../common/utils/with-timeout';
import { ORPHAN_AGE_MS } from './capture-limits';

const PAGE_SIZE = 1000;
const STARTUP_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 60_000;

type OrphanReason = 'api_restart' | 'stale';

/**
 * Fails capture rows left `running` by a process that no longer owns them
 * (restart, crash, OOM). Never loads chunk bytes.
 */
@Injectable()
export class CaptureSessionReconciler {
  private readonly logger = new Logger(CaptureSessionReconciler.name);
  private readonly reconcileOnStartupEnabled = !isNegativeEnvValue(
    process.env.MONITOR_CAPTURE_RECONCILE_ON_STARTUP,
  );
  private sweepTimer?: NodeJS.Timeout;

  constructor(@Inject('STORAGE_CLIENT') private readonly storage: StoragePort) {}

  async reconcileOnStartup(activeIds: () => ReadonlySet<string>): Promise<void> {
    if (!this.reconcileOnStartupEnabled) return;
    try {
      await withTimeout(
        this.reconcile('api_restart', activeIds, () => true),
        STARTUP_TIMEOUT_MS,
        'Capture session reconciliation timed out',
      );
    } catch (err) {
      this.logger.warn(`Startup capture reconciliation failed: ${(err as Error).message}`);
    }
  }

  startSweep(activeIds: () => ReadonlySet<string>): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.reconcile('stale', activeIds, (s) => s.startedAt < Date.now() - ORPHAN_AGE_MS).catch(
        (err: Error) => {
          this.logger.warn(`Capture session sweep failed: ${err.message}`);
        },
      );
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  async reconcile(
    reason: OrphanReason,
    activeIds: () => ReadonlySet<string>,
    eligible: (s: StoredCaptureSession) => boolean,
  ): Promise<number> {
    let count = 0;
    try {
      const running: StoredCaptureSession[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await this.storage.getCaptureSessions({
          status: 'running',
          limit: PAGE_SIZE,
          offset,
        });
        running.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      for (const s of running) {
        // Re-read ownership per row: a session may have become active meanwhile.
        if (activeIds().has(s.id) || !eligible(s)) continue;
        try {
          await this.failSession(s, reason);
          count++;
        } catch (err) {
          this.logger.warn(
            `Failed to reconcile capture session ${s.id}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`Capture session reconciliation failed: ${(err as Error).message}`);
    }
    if (count > 0) {
      this.logger.log(`Reconciled ${count} orphaned capture session(s) (${reason})`);
    }
    return count;
  }

  private async failSession(s: StoredCaptureSession, reason: OrphanReason): Promise<void> {
    const last = await this.storage.getCaptureChunkLastTs(s.id);
    const endedAt = last?.lastTs ?? Date.now();
    const segments: CaptureNodeSegment[] | undefined = s.nodeSegments?.map((seg) =>
      seg.status === 'running'
        ? {
            ...seg,
            status: 'failed',
            terminationReason: reason,
            endedAt: last?.byNode[seg.nodeId] ?? endedAt,
          }
        : seg,
    );
    await this.storage.updateCaptureSession(s.id, {
      status: 'failed',
      terminationReason: reason,
      endedAt,
      durationMs: endedAt - s.startedAt,
      ...(segments ? { nodeSegments: segments } : {}),
    });
  }
}
