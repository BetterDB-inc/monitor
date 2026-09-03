import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LicenseService } from '@proprietary/licenses/license.service';
import { StoragePort } from '@app/common/interfaces/storage-port.interface';
import { RetentionPolicyService, MS_PER_DAY } from '@app/retention/retention-policy.service';
import { runRetentionSweep, totalPruned } from '@app/retention/retention-sweep';
import { isCloudMode } from '@app/common/utils/cloud-mode';

@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(
    private readonly licenseService: LicenseService,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly retentionPolicy: RetentionPolicyService,
  ) {}

  @Cron('0 3 * * *')
  async handleRetentionCron(): Promise<void> {
    if (!isCloudMode()) {
      this.logger.debug('Data retention skipped (not in CLOUD_MODE)');
      return;
    }

    await this.runRetention();
  }

  async runRetention(): Promise<void> {
    if (!isCloudMode()) {
      this.logger.log('Skipping retention: not in CLOUD_MODE');
      return;
    }

    const tier = this.licenseService.getLicenseTier();
    // In cloud mode the policy always resolves to the tier window, never null.
    const retentionDays = this.retentionPolicy.getRetentionDays()!;
    const cutoff = Date.now() - retentionDays * MS_PER_DAY;
    // The sample stores keep their tighter cloud cap even in the sweep — it
    // is the only pruner that reaches removed/unreachable connections' rows.
    const sampleCutoff = Date.now() - this.retentionPolicy.getSampleRetentionMs()!;

    this.logger.log(`Running data retention: tier=${tier}, retentionDays=${retentionDays}, cutoff=${new Date(cutoff).toISOString()}`);

    const results = await runRetentionSweep(this.storage, cutoff, this.logger, sampleCutoff);

    this.logger.log(`Retention complete: ${totalPruned(results)} total rows pruned — ${JSON.stringify(results)}`);
  }
}
