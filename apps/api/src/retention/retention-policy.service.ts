import { Injectable, Optional } from '@nestjs/common';
import { Tier, TIER_RETENTION_DAYS } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';
import { SettingsService } from '../settings/settings.service';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolves the effective retention window for stored monitoring history.
 *
 * Cloud: always the license tier's window (7/90/365) — the managed policy,
 * operators cannot override it. Self-hosted: the operator-configured
 * `localRetentionDays` setting (seeded from the LOCAL_RETENTION_DAYS env var)
 * when set, otherwise null — nothing is deleted by default.
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

  /**
   * Effective window for feature-level pruning, or null when nothing should
   * be pruned (self-hosted with no window configured).
   */
  getRetentionDays(): number | null {
    if (process.env.CLOUD_MODE === 'true') {
      const tier = this.licenseService?.getLicenseTier() ?? Tier.community;
      return TIER_RETENTION_DAYS[tier];
    }
    return this.getLocalRetentionDays();
  }

  getRetentionMs(): number | null {
    const days = this.getRetentionDays();
    return days === null ? null : days * MS_PER_DAY;
  }
}
