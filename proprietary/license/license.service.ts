import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Tier, Feature, TIER_FEATURES, EntitlementResponse } from './types';

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
  private readonly instanceId: string;
  private readonly telemetryEnabled: boolean;

  private cache: CachedEntitlement | null = null;
  private validationPromise: Promise<EntitlementResponse> | null = null;
  private isValidated = false;

  constructor(private readonly config: ConfigService) {
    this.licenseKey = process.env.BETTERDB_LICENSE_KEY || null;
    this.entitlementUrl = process.env.ENTITLEMENT_URL || 'https://betterdb.com/api/v1/entitlements';
    this.cacheTtlMs = parseInt(process.env.LICENSE_CACHE_TTL_MS || '3600000', 10);
    this.maxStaleCacheMs = parseInt(process.env.LICENSE_MAX_STALE_MS || '604800000', 10);
    this.timeoutMs = parseInt(process.env.LICENSE_TIMEOUT_MS || '10000', 10);
    this.instanceId = this.generateInstanceId();
    this.telemetryEnabled = process.env.BETTERDB_TELEMETRY !== 'false';
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
    // Always validate entitlements on startup, regardless of license key presence.
    // This serves as both license validation (for keyed instances) and a startup ping
    // (for keyless instances). The entitlement check is a functional licensing concern,
    // not telemetry - it runs even when BETTERDB_TELEMETRY=false.
    if (!this.licenseKey) {
      this.logger.log('No license key provided, checking entitlements for Community tier...');
    } else {
      this.logger.log('Starting license validation in background...');
    }
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
    // Always call the entitlement server, even for keyless instances.
    // This ensures we have visibility into all deployments and can remotely
    // grant beta/free features to keyless instances.

    if (this.cache && Date.now() - this.cache.cachedAt < this.cacheTtlMs) {
      this.logger.debug('Using cached entitlement');
      return this.cache.response;
    }

    try {
      const response = await this.checkOnline();
      this.cache = { response, cachedAt: Date.now() };
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

  private async checkOnline(): Promise<EntitlementResponse> {
    const payload = {
      licenseKey: this.licenseKey || '', // Empty string for keyless instances
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

      return response.json();
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

  async sendTelemetry(eventType: string, data: Record<string, unknown> = {}): Promise<void> {
    if (!this.telemetryEnabled) {
      return;
    }

    const payload = {
      instanceId: this.instanceId,
      eventType,
      tier: this.getLicenseTier(),
      ...data,
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
      // Telemetry is best-effort, don't log failures
    } finally {
      clearTimeout(timeout);
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
}
