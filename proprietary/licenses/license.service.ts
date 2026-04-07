import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { compare, valid as validSemver } from 'semver';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { Tier, Feature, TIER_FEATURES, EntitlementResponse, EntitlementRequest } from './types';
import type { VersionInfo } from '@betterdb/shared';
import { TelemetryPort } from '@app/common/interfaces/telemetry-port.interface';

const LICENSE_KEY_FILE = join(__dirname, '..', '..', 'data', 'license.key');

interface CachedEntitlement {
  response: EntitlementResponse;
  cachedAt: number;
}

@Injectable()
export class LicenseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LicenseService.name);
  private licenseKey: string | null;
  private readonly entitlementUrl: string;
  private readonly cacheTtlMs: number;
  private readonly maxStaleCacheMs: number;
  private readonly timeoutMs: number;
  private readonly instanceId: string;
  private readonly telemetryEnabled: boolean;
  private readonly versionCheckIntervalMs: number;

  private cache: CachedEntitlement | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  public validationPromise: Promise<EntitlementResponse> | null = null;
  private isValidated = false;

  // Version check state
  private readonly currentVersion: string;
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private versionCheckedAt: number | null = null;

  constructor(
    private readonly config: ConfigService,
    @Inject('TELEMETRY_CLIENT') @Optional() private readonly telemetryClient?: TelemetryPort,
  ) {
    this.currentVersion =
      process.env.APP_VERSION || process.env.npm_package_version || 'unknown';
    this.licenseKey = process.env.BETTERDB_LICENSE_KEY || this.loadPersistedKey();
    // Use the canonical www host directly: the apex betterdb.com 307-redirects
    // to www, and Node's fetch doesn't always preserve POST bodies across
    // cross-host redirects, which would silently break license validation.
    this.entitlementUrl = process.env.ENTITLEMENT_URL || 'https://www.betterdb.com/api/v1/entitlements';
    this.cacheTtlMs = parseInt(process.env.LICENSE_CACHE_TTL_MS || '3600000', 10);
    this.maxStaleCacheMs = parseInt(process.env.LICENSE_MAX_STALE_MS || '604800000', 10);
    this.timeoutMs = parseInt(process.env.LICENSE_TIMEOUT_MS || '10000', 10);
    this.instanceId = this.generateInstanceId();
    this.telemetryEnabled = process.env.BETTERDB_TELEMETRY !== 'false';
    this.versionCheckIntervalMs = this.config.get<number>('VERSION_CHECK_INTERVAL_MS') || 3600000;
  }

  private generateInstanceId(): string {
    // Use infrastructure identifiers only - avoid including license key to prevent fingerprinting
    const dbHost = process.env.DB_HOST || '';
    const dbPort = process.env.DB_PORT || '';
    const storageUrl = process.env.STORAGE_URL || '';
    const hostname = process.env.HOSTNAME || '';

    const input = `${dbHost}|${dbPort}|${storageUrl}|${hostname}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  async onModuleInit() {
    // Always log current version on startup
    this.logger.log(`BetterDB Monitor v${this.currentVersion}`);

    // Always validate entitlements on startup, regardless of license key presence
    // in order to enable beta features for keyless instances.
    if (!this.licenseKey) {
      this.logger.log('No license key provided, checking entitlements for Community tier...');
    } else {
      this.logger.log('Starting license validation in background...');
    }
    this.validationPromise = this.validateLicenseBackground();

    if (this.telemetryEnabled) {
      this.heartbeatTimer = setInterval(() => {
        this.collectStats().then(stats => {
          this.sendHeartbeat(stats);
        });
        this.validateLicense().catch(() => {
          // Version check is best-effort
        });
      }, this.versionCheckIntervalMs);
      this.logger.log(`Telemetry heartbeat scheduled every ${this.versionCheckIntervalMs}ms`);
    }
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async validateLicenseBackground(): Promise<EntitlementResponse> {
    try {
      const result = await this.validateLicense();
      this.isValidated = true;
      this.logger.log('License validation complete, isValidated=true');

      if (result.tier !== Tier.community) {
        this.logger.log(`License validated: upgraded to ${result.tier} tier`);
      }
      return result;
    } catch (error) {
      this.logger.warn(`License validation failed: ${(error as Error).message}, remaining in Community tier`);
      this.isValidated = true;
      this.logger.log('License validation complete (fallback), isValidated=true');
      return this.getCommunityEntitlement('Validation failed');
    }
  }

  async validateLicense(): Promise<EntitlementResponse> {
    if (this.cache && Date.now() - this.cache.cachedAt < this.cacheTtlMs) {
      this.logger.debug('Using cached entitlement');
      return this.cache.response;
    }

    const validationKey = this.licenseKey;

    try {
      const response = await this.checkOnline(validationKey);

      if (this.licenseKey === validationKey) {
        this.cache = { response, cachedAt: Date.now() };
      } else {
        this.logger.debug('Discarding stale entitlement response after license key change');
      }

      this.logger.log(`Entitlement validated: ${response.tier}`);
      return response;
    } catch (error) {
      this.logger.error(`Entitlement validation failed: ${(error as Error).message}`);

      if (this.cache && Date.now() - this.cache.cachedAt < this.maxStaleCacheMs) {
        this.logger.warn('Using stale cache');
        return this.cache.response;
      }

      return this.getCommunityEntitlement('Validation failed');
    }
  }

  private async checkOnline(licenseKeyOverride?: string | null): Promise<EntitlementResponse> {
    const isCloud = process.env.CLOUD_MODE === 'true';
    const payload: EntitlementRequest = {
      licenseKey: licenseKeyOverride ?? this.licenseKey ?? '', // Empty string for keyless instances
      instanceId: this.instanceId,
      eventType: 'license_check',
      deploymentMode: isCloud ? 'cloud' : 'self-hosted',
      stats: await this.collectStats(),
      ...(isCloud && process.env.DB_SCHEMA ? { tenantId: process.env.DB_SCHEMA } : {}),
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

  private sendHeartbeat(data: Record<string, unknown> = {}): void {
    if (!this.telemetryEnabled || !this.telemetryClient) {
      return;
    }

    try {
      this.telemetryClient.capture({
        distinctId: this.instanceId,
        event: 'telemetry_ping',
        properties: {
          tier: this.getLicenseTier(),
          deploymentMode:
            process.env.CLOUD_MODE === 'true' ? 'cloud' : 'self-hosted',
          ...data,
        },
      });
    } catch {
      // Telemetry is best-effort, don't log failures
    }
  }


  /**
   * Load a previously persisted license key from disk.
   */
  private loadPersistedKey(): string | null {
    try {
      const key = readFileSync(LICENSE_KEY_FILE, 'utf-8').trim();
      if (key) {
        this.logger.log('Loaded license key from persisted file');
        return key;
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
    return null;
  }

  /**
   * Activate a license key at runtime by validating first, then persisting only
   * after successful validation so an existing valid key is never overwritten by
   * a bad or unvalidated key.
   */
  async activateLicenseKey(key: string): Promise<EntitlementResponse> {
    let info: EntitlementResponse;
    try {
      // Validate against the candidate key without mutating shared state first.
      info = await this.checkOnline(key);
    } catch (error) {
      this.logger.error(`Entitlement validation failed: ${(error as Error).message}`);
      info = this.getCommunityEntitlement('Validation failed');
    }

    if (!info.valid) {
      this.logger.warn(`License activation failed: ${info.error || 'unknown error'}`);
      return info;
    }

    // Commit shared state only after candidate validation succeeds.
    this.licenseKey = key;
    this.cache = { response: info, cachedAt: Date.now() };
    this.validationPromise = Promise.resolve(info);
    this.isValidated = true;

    try {
      mkdirSync(join(__dirname, '..', '..', 'data'), { recursive: true });
      writeFileSync(LICENSE_KEY_FILE, key, { encoding: 'utf-8', mode: 0o600 });
      this.logger.log('License key persisted to disk');
    } catch (error) {
      this.logger.warn(`Failed to persist license key: ${(error as Error).message}`);
    }

    return info;
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

  getInstanceId(): string {
    return this.instanceId;
  }

  get isTelemetryEnabled(): boolean {
    return this.telemetryEnabled;
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
      versionCheckIntervalMs: this.versionCheckIntervalMs,
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
   * Report a startup error to the entitlement server.
   * Bypasses the telemetryEnabled check — startup errors are always sent
   * because users who hit fatal errors and bail are the ones we most need
   * visibility into, and they never get a chance to opt in.
   */
  async sendStartupError(errorMessage: string, errorCategory: string): Promise<void> {
    const payload = {
      licenseKey: this.licenseKey || '',
      instanceId: this.instanceId,
      eventType: 'startup_error',
      errorMessage: errorMessage.slice(0, 500),
      errorCategory,
      deploymentMode: process.env.CLOUD_MODE === 'true' ? 'cloud' as const : 'self-hosted' as const,
      version: process.env.APP_VERSION || process.env.npm_package_version || 'unknown',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptime: process.uptime(),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      await fetch(this.entitlementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch {
      // Best-effort — process is about to exit anyway
    } finally {
      clearTimeout(timeout);
    }
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
