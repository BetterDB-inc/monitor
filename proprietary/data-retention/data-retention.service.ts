import { Injectable, Logger, Inject, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { LicenseService } from '@proprietary/license/license.service';
import { Tier } from '@proprietary/license/types';
import { StoragePort } from '@app/common/interfaces/storage-port.interface';

const RETENTION_DAYS: Record<Tier, number> = {
  [Tier.community]: 7,
  [Tier.pro]: 90,
  [Tier.enterprise]: 365,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class DataRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataRetentionService.name);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly licenseService: LicenseService,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  onModuleInit() {
    if (process.env.CLOUD_MODE !== 'true') {
      this.logger.log('Data retention disabled (not in CLOUD_MODE)');
      return;
    }

    this.scheduleNext();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext() {
    const now = new Date();
    const next3am = new Date(now);
    next3am.setHours(3, 0, 0, 0);
    if (next3am.getTime() <= now.getTime()) {
      next3am.setDate(next3am.getDate() + 1);
    }
    const delayMs = next3am.getTime() - now.getTime();

    this.logger.log(`Next retention run scheduled in ${Math.round(delayMs / 60000)} minutes`);

    this.timer = setTimeout(() => {
      this.runRetention()
        .catch(err => this.logger.error('Retention run failed:', err))
        .finally(() => this.scheduleNext());
    }, delayMs);
  }

  async runRetention(): Promise<void> {
    if (process.env.CLOUD_MODE !== 'true') {
      this.logger.log('Skipping retention: not in CLOUD_MODE');
      return;
    }

    const tier = this.licenseService.getLicenseTier();
    const retentionDays = RETENTION_DAYS[tier];
    const cutoff = Date.now() - retentionDays * MS_PER_DAY;

    this.logger.log(`Running data retention: tier=${tier}, retentionDays=${retentionDays}, cutoff=${new Date(cutoff).toISOString()}`);

    const results: Record<string, number> = {};

    const pruneOps: Array<{ name: string; fn: () => Promise<number> }> = [
      { name: 'slowlog', fn: () => this.storage.pruneOldSlowLogEntries(cutoff) },
      { name: 'commandlog', fn: () => this.storage.pruneOldCommandLogEntries(cutoff) },
      { name: 'client_snapshots', fn: () => this.storage.pruneOldClientSnapshots(cutoff) },
      { name: 'anomaly_events', fn: () => this.storage.pruneOldAnomalyEvents(cutoff) },
      { name: 'correlated_groups', fn: () => this.storage.pruneOldCorrelatedGroups(cutoff) },
      { name: 'key_patterns', fn: () => this.storage.pruneOldKeyPatternSnapshots(cutoff) },
      { name: 'acl_entries', fn: () => this.storage.pruneOldEntries(cutoff) },
      { name: 'webhook_deliveries', fn: () => this.storage.pruneOldDeliveries(cutoff) },
    ];

    for (const op of pruneOps) {
      try {
        results[op.name] = await op.fn();
      } catch (err) {
        this.logger.error(`Failed to prune ${op.name}:`, err);
        results[op.name] = -1;
      }
    }

    const total = Object.values(results).filter(v => v > 0).reduce((a, b) => a + b, 0);
    this.logger.log(`Retention complete: ${total} total rows pruned — ${JSON.stringify(results)}`);
  }
}
