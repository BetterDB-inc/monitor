import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { compare, valid as validSemver } from 'semver';
import { Tier, Feature, TIER_FEATURES, EntitlementResponse } from './types';
import type { VersionInfo } from '@betterdb/shared';

interface CachedEntitlement {
  response: EntitlementResponse;
  cachedAt: number;
}

@Injectable()
export class LicenseService implements OnModuleInit {
  private readonly logger = new Logger(LicenseService.name);
  private readonly licenseKey: string | null;
  private readonly entitlementUrl: string;
  private readonly cacheTtlMs: number;
  private readonly maxStaleCacheMs: number;
  private readonly timeoutMs: number;
  private readonly telemetryEnabled: boolean;
  private readonly instanceId: string;

  private cache: CachedEntitlement | null = null;
  private validationPromise: Promise<EntitlementResponse> | null = null;
  private isValidated = false;

  // Version check state
  private readonly currentVersion: string;
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private versionCheckedAt: number | null = null;

  constructor(private readonly config: ConfigService) {
    this.currentVersion =
      process.env.APP_VERSION || process.env.npm_package_version || 'unknown';
    this.licenseKey = process.env.BETTERDB_LICENSE_KEY || null;
    this.entitlementUrl = process.env.ENTITLEMENT_URL || 'https://betterdb.com/api/v1/entitlements';
    this.cacheTtlMs = parseInt(process.env.LICENSE_CACHE_TTL_MS || '3600000', 10);
    this.maxStaleCacheMs = parseInt(process.env.LICENSE_MAX_STALE_MS || '604800000', 10);
    this.timeoutMs = parseInt(process.env.LICENSE_TIMEOUT_MS || '10000', 10);
    this.telemetryEnabled = process.env.BETTERDB_TELEMETRY !== 'false';
    this.instanceId = this.generateInstanceId();
  }

  private generateInstanceId(): string {
    const dbHost = process.env.DB_HOST || '';
    const dbPort = process.env.DB_PORT || '';
    const storageUrl = process.env.STORAGE_URL || '';
    const licenseKey = process.env.BETTERDB_LICENSE_KEY || '';

    const input = `${dbHost}|${dbPort}|${storageUrl}|${licenseKey}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  async onModuleInit() {
    // Always log current version on startup
    this.logger.log(`BetterDB Monitor v${this.currentVersion}`);

    if (!this.licenseKey) {
      // No license key - definitely community tier
      this.isValidated = true;
      this.logger.log('No license key provided, running in Community tier');

      if (this.telemetryEnabled) {
        // Send telemetry ping in background (don't await)
        this.pingTelemetry().catch(err => {
          this.logger.debug(`Telemetry ping failed: ${err.message}`);
        });
      }
      return;
    }

    // Start validation in background (don't block startup)
    this.logger.log('Starting license validation in background...');
    this.validationPromise = this.validateLicenseBackground();
  }

  private async validateLicenseBackground(): Promise<EntitlementResponse> {
    try {
      const result = await this.validateLicense();
      this.isValidated = true;

      if (result.tier !== Tier.community) {
        this.logger.log(`License validated: upgraded to ${result.tier} tier`);
      }
      return result;
    } catch (error) {
      this.logger.warn(`License validation failed: ${(error as Error).message}, remaining in Community tier`);
      this.isValidated = true;
      return this.getCommunityEntitlement('Validation failed');
    }
  }

  async validateLicense(): Promise<EntitlementResponse> {
    if (!this.licenseKey) {
      this.logger.log('No license key provided, running in Community tier');
      return this.getCommunityEntitlement();
    }

    if (this.cache && Date.now() - this.cache.cachedAt < this.cacheTtlMs) {
      this.logger.debug('Using cached entitlement');
      return this.cache.response;
    }

    try {
      const response = await this.checkOnline();
      this.cache = { response, cachedAt: Date.now() };
      this.logger.log(`License validated: ${response.tier}`);
      return response;
    } catch (error) {
      this.logger.error(`License validation failed: ${(error as Error).message}`);

      if (this.cache && Date.now() - this.cache.cachedAt < this.maxStaleCacheMs) {
        this.logger.warn('Using stale cache');
        return this.cache.response;
      }

      return this.getCommunityEntitlement('Validation failed');
    }
  }

  private async checkOnline(): Promise<EntitlementResponse> {
    const payload = {
      licenseKey: this.licenseKey,
      instanceId: this.instanceId,
      eventType: 'license_check',
      stats: await this.collectStats(),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.entitlementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Entitlement server returned ${response.status}`);
      }

      const data = await response.json();

      // Store version info from entitlement response
      if (data.latestVersion) {
        this.setLatestVersion(data.latestVersion, data.releaseUrl);
      }

      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async collectStats(): Promise<Record<string, any>> {
    return {
      version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  }

  private async pingTelemetry(): Promise<void> {
    if (!this.telemetryEnabled) {
      return;
    }

    try {
      const payload = {
        instanceId: this.instanceId,
        eventType: 'telemetry_ping',
        version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        tier: 'community',
      };

      this.logger.debug(`Sending telemetry ping: ${JSON.stringify(payload)}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(this.entitlementUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        this.logger.debug(`Telemetry ping response: ${response.status}`);

        // Store version info from telemetry response
        if (response.ok) {
          try {
            const data = await response.json();
            if (data.latestVersion) {
              this.setLatestVersion(data.latestVersion, data.releaseUrl);
            }
          } catch {
            // No JSON in response - ignore
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.logger.debug(`Telemetry ping failed: ${(error as Error).message}`);
    }
  }

  private getCommunityEntitlement(error?: string): EntitlementResponse {
    return {
      valid: !error,
      tier: Tier.community,
      expiresAt: null,
      error,
    };
  }

  hasFeature(feature: Feature | string): boolean {
    const entitlement = this.cache?.response || this.getCommunityEntitlement();
    // Derive features from tier using TIER_FEATURES mapping
    const tierFeatures = TIER_FEATURES[entitlement.tier];
    return tierFeatures.includes(feature as Feature);
  }

  getLicenseTier(): Tier {
    return this.cache?.response?.tier || Tier.community;
  }

  getLicenseInfo(): EntitlementResponse {
    return this.cache?.response || this.getCommunityEntitlement();
  }

  async refreshLicense(): Promise<EntitlementResponse> {
    this.cache = null;
    this.isValidated = false;
    this.validationPromise = this.validateLicenseBackground();
    return this.validationPromise;
  }

  /**
   * Wait for license validation to complete (with timeout).
   * Use this for routes that require paid tier access.
   * Returns cached result if already validated.
   */
  async ensureValidated(timeoutMs = 5000): Promise<EntitlementResponse> {
    // Already validated - return cached result
    if (this.isValidated && this.cache) {
      return this.cache.response;
    }

    // No validation in progress (community tier)
    if (!this.validationPromise) {
      return this.getCommunityEntitlement();
    }

    // Wait for validation with timeout
    const timeout = new Promise<EntitlementResponse>((_, reject) =>
      setTimeout(() => reject(new Error('License validation timeout')), timeoutMs),
    );

    try {
      return await Promise.race([this.validationPromise, timeout]);
    } catch (error) {
      this.logger.warn(`ensureValidated timeout, using community tier: ${(error as Error).message}`);
      return this.getCommunityEntitlement('Validation timeout');
    }
  }

  /**
   * Check if license validation has completed
   */
  isValidationComplete(): boolean {
    return this.isValidated;
  }

  // ─────────────────────────────────────────────────────────────
  // Version Check Methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Store latest version from entitlement/telemetry response
   */
  private setLatestVersion(version: string, url?: string): void {
    const cleanVersion = version.startsWith('v') ? version.slice(1) : version;

    if (!validSemver(cleanVersion)) {
      this.logger.debug(`Ignoring invalid version: ${version}`);
      return;
    }

    this.latestVersion = cleanVersion;
    this.releaseUrl =
      url || `https://github.com/betterdb-inc/monitor/releases/tag/v${cleanVersion}`;
    this.versionCheckedAt = Date.now();

    this.logUpdateStatus();
  }

  /**
   * Get full version info for API endpoint
   */
  getVersionInfo(): VersionInfo {
    return {
      current: this.currentVersion,
      latest: this.latestVersion,
      updateAvailable: this.isUpdateAvailable(),
      releaseUrl: this.releaseUrl,
      checkedAt: this.versionCheckedAt,
    };
  }

  /**
   * Check if an update is available
   */
  isUpdateAvailable(): boolean {
    if (!this.latestVersion || this.currentVersion === 'unknown') {
      return false;
    }

    const currentValid = validSemver(this.currentVersion);
    const latestValid = validSemver(this.latestVersion);

    if (!currentValid || !latestValid) {
      return false;
    }

    return compare(this.latestVersion, this.currentVersion) > 0;
  }

  /**
   * Log update status to console
   */
  private logUpdateStatus(): void {
    if (this.isUpdateAvailable()) {
      this.logger.warn('─────────────────────────────────────────────────────');
      this.logger.warn(
        `UPDATE AVAILABLE: v${this.currentVersion} → v${this.latestVersion}`,
      );
      if (this.releaseUrl) {
        this.logger.warn(`Release notes: ${this.releaseUrl}`);
      }
      this.logger.warn('Run: docker pull betterdb/monitor:latest');
      this.logger.warn('─────────────────────────────────────────────────────');
    } else if (this.latestVersion) {
      this.logger.log(`You are running the latest version (v${this.currentVersion})`);
    }
  }
}
