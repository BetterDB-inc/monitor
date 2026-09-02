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

  private startupTimer: NodeJS.Timeout | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly retentionPolicy: RetentionPolicyService,
  ) {}

  onModuleInit(): void {
    if (process.env.CLOUD_MODE === 'true') return;

    this.startupTimer = setTimeout(() => {
      void this.runSweep();
      this.sweepTimer = setInterval(() => void this.runSweep(), this.SWEEP_INTERVAL_MS);
    }, this.STARTUP_DELAY_MS);
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.startupTimer = null;
    this.sweepTimer = null;
  }

  async runSweep(): Promise<void> {
    if (process.env.CLOUD_MODE === 'true') return;

    const days = this.retentionPolicy.getLocalRetentionDays();
    if (days === null) {
      this.logger.debug('Local retention sweep skipped: no retention window configured');
      return;
    }

    const cutoff = Date.now() - days * MS_PER_DAY;
    this.logger.log(
      `Running local retention sweep: retentionDays=${days}, cutoff=${new Date(cutoff).toISOString()}`,
    );

    try {
      const results = await runRetentionSweep(this.storage, cutoff, this.logger);
      this.logger.log(
        `Local retention sweep complete: ${totalPruned(results)} total rows pruned — ${JSON.stringify(results)}`,
      );
    } catch (err) {
      this.logger.error('Local retention sweep failed:', err);
    }
  }
}
