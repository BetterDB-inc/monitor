import {
  Injectable,
  Inject,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { MS_PER_DAY, RetentionPolicyService } from './retention-policy.service';
import { runRetentionSweep, totalPruned } from './retention-sweep';
import { isCloudMode } from '../common/utils/cloud-mode';

/**
 * Daily retention sweep for self-hosted deployments. Disabled entirely in
 * cloud mode (the tier-based DataRetentionService owns retention there) and a
 * no-op until the operator sets `localRetentionDays` — the default remains
 * keep-forever.
 */
@Injectable()
export class LocalRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocalRetentionService.name);

  private readonly SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  // Delay the first sweep so startup isn't competing with schema migrations
  // and the initial poller burst.
  private readonly STARTUP_DELAY_MS = 5 * 60 * 1000;

  private sweepTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly retentionPolicy: RetentionPolicyService,
  ) {}

  onModuleInit(): void {
    if (isCloudMode()) return;
    this.schedule(this.STARTUP_DELAY_MS);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  // Re-arm AFTER the sweep completes (like MultiConnectionPoller) instead of
  // a fixed setInterval: a first sweep over years of keep-forever history can
  // outlive the interval, and an overlapping second sweep would contend on
  // the same tables for no benefit.
  private schedule(delayMs: number): void {
    if (this.destroyed) return;
    this.sweepTimer = setTimeout(async () => {
      try {
        await this.runSweep();
      } catch (err) {
        // The single failure handler for the sweep. Never let a rejection
        // escape the timer callback: it would reach main.ts's process-level
        // handler, which exits the process. Log, skip this pass, and try
        // again next cycle.
        this.logger.error('Local retention sweep failed:', err);
      } finally {
        this.schedule(this.SWEEP_INTERVAL_MS);
      }
    }, delayMs);
  }

  async runSweep(): Promise<void> {
    if (isCloudMode()) return;

    const days = this.retentionPolicy.getLocalRetentionDays();
    if (days === null) {
      this.logger.debug('Local retention sweep skipped: no retention window configured');
      return;
    }

    const cutoff = Date.now() - days * MS_PER_DAY;
    this.logger.log(
      `Running local retention sweep: retentionDays=${days}, cutoff=${new Date(cutoff).toISOString()}`,
    );

    // No local try/catch: the timer callback in schedule() is the single
    // failure handler (it logs and re-arms), and letting errors propagate
    // keeps them observable to direct callers such as tests.
    const results = await runRetentionSweep(this.storage, cutoff, this.logger);
    this.logger.log(
      `Local retention sweep complete: ${totalPruned(results)} total rows pruned — ${JSON.stringify(results)}`,
    );
  }
}
