import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LicenseService } from '@proprietary/licenses/license.service';
import { TIER_RETENTION_DAYS } from '@proprietary/licenses/types';
import { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { runRetentionSweep, totalPruned } from '@app/retention/retention-sweep';

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
    const retentionDays = TIER_RETENTION_DAYS[tier];
    const cutoff = Date.now() - retentionDays * MS_PER_DAY;

    this.logger.log(`Running data retention: tier=${tier}, retentionDays=${retentionDays}, cutoff=${new Date(cutoff).toISOString()}`);

    const results = await runRetentionSweep(this.storage, cutoff, this.logger);

    this.logger.log(`Retention complete: ${totalPruned(results)} total rows pruned — ${JSON.stringify(results)}`);
  }
}
