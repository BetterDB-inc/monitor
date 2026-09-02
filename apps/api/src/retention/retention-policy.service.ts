import { Injectable, Optional } from '@nestjs/common';
import { Tier, TIER_RETENTION_DAYS } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';
import { SettingsService } from '../settings/settings.service';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolves the effective retention window for stored monitoring history.
 *
 * Self-hosted: the operator-configured `localRetentionDays` setting (seeded
 * from the LOCAL_RETENTION_DAYS env var) wins when set; otherwise the license
 * tier's default window applies. Cloud: always the tier default — operators
 * cannot override the managed policy.
 */
@Injectable()
export class RetentionPolicyService {
  constructor(
    private readonly settingsService: SettingsService,
    @Optional() private readonly licenseService?: LicenseService,
  ) {}

  /**
   * The operator-configured self-hosted retention window in days, or null
   * when unset (or when running in cloud mode).
   */
  getLocalRetentionDays(): number | null {
    if (process.env.CLOUD_MODE === 'true') return null;
    const days = this.settingsService.getCachedSettings().localRetentionDays;
    return typeof days === 'number' && Number.isFinite(days) && days >= 1
      ? Math.floor(days)
      : null;
  }

  /** Effective window for feature-level pruning: operator override, else the license tier's default. */
  getRetentionDays(): number {
    const local = this.getLocalRetentionDays();
    if (local !== null) return local;
    const tier = this.licenseService?.getLicenseTier() ?? Tier.community;
    return TIER_RETENTION_DAYS[tier];
  }

  getRetentionMs(): number {
    return this.getRetentionDays() * MS_PER_DAY;
  }
}
