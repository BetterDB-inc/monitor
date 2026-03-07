import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    private readonly licenseService: LicenseService,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  @Cron('0 3 * * *')
  async handleRetentionCron(): Promise<void> {
    if (process.env.CLOUD_MODE !== 'true') {
      this.logger.debug('Data retention skipped (not in CLOUD_MODE)');
      return;
    }

    await this.runRetention();
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
