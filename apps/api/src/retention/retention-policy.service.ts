import { Injectable, Logger, Optional } from '@nestjs/common';
import { Tier, TIER_RETENTION_DAYS, normalizeRetentionDays } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';
import { SettingsService } from '../settings/settings.service';
import { isCloudMode } from '../common/utils/cloud-mode';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Hard cap for the high-volume sample stores (command/latency stats samples,
// vector index snapshots) in cloud deployments. These tables gain rows per
// connection per poll tick, so they keep the tight window they have always
// had instead of the tier's analytics-history window. AI cache samples and
// OTel spans are NOT capped this way in cloud: the tier-based sweep has
// always owned them there at the full tier window (this method still governs
// them self-hosted, where the poller prunes locally).
const CLOUD_SAMPLE_RETENTION_DAYS = 7;

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
  private readonly logger = new Logger(RetentionPolicyService.name);
  // String key of the invalid stored value we already warned about, so the
  // per-poll reads don't repeat the warning every tick. Stringified (identity
  // comparison would never dedup a non-primitive like a blob) and cleared
  // when the value recovers, so each invalid EPISODE warns exactly once.
  private warnedInvalidStoredValue?: string;

  constructor(
    private readonly settingsService: SettingsService,
    @Optional() private readonly licenseService?: LicenseService,
  ) {}

  /**
   * The operator-configured self-hosted retention window in days, or null
   * when unset (or when running in cloud mode).
   */
  getLocalRetentionDays(): number | null {
    if (isCloudMode()) return null;
    // Only the persisted settings count. The env-fallback view that
    // getCachedSettings() serves before the first cache load could resurrect
    // a window the operator explicitly cleared in the UI; until real settings
    // are loaded we simply don't prune.
    const settings = this.settingsService.getLoadedSettings();
    if (!settings) return null;
    // Same strict validator as every write path — a malformed persisted value
    // (e.g. a direct DB edit) is treated as unset, never coerced into a
    // deletion window the operator did not ask for. Warn once per invalid
    // episode so the "why isn't retention running" question is answerable
    // from the logs.
    const stored = settings.localRetentionDays;
    const normalized = normalizeRetentionDays(stored);
    if (stored == null || normalized !== null) {
      this.warnedInvalidStoredValue = undefined; // episode over — warn again next time
    } else {
      const key = String(stored);
      if (this.warnedInvalidStoredValue !== key) {
        this.warnedInvalidStoredValue = key;
        this.logger.warn(
          `Ignoring invalid stored localRetentionDays=${key} — retention is treated as unset (keep forever)`,
        );
      }
    }
    return normalized;
  }

  /**
   * Effective window for feature-level pruning, or null when nothing should
   * be pruned (self-hosted with no window configured).
   */
  getRetentionDays(): number | null {
    if (isCloudMode()) {
      const tier = this.licenseService?.getLicenseTier() ?? Tier.community;
      return TIER_RETENTION_DAYS[tier];
    }
    return this.getLocalRetentionDays();
  }

  getRetentionMs(): number | null {
    const days = this.getRetentionDays();
    return days === null ? null : days * MS_PER_DAY;
  }

  /**
   * Window for the high-volume sample stores. Cloud keeps its longstanding
   * 7-day cap regardless of tier; self-hosted follows the operator's window
   * (null = keep forever, like everything else).
   */
  getSampleRetentionMs(): number | null {
    if (isCloudMode()) {
      return CLOUD_SAMPLE_RETENTION_DAYS * MS_PER_DAY;
    }
    return this.getRetentionMs();
  }
}
