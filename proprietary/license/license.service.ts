import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Tier, Feature, TIER_FEATURES, TIER_INSTANCE_LIMITS, TIER_RETENTION_LIMITS, EntitlementResponse } from './types';

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

  private cache: CachedEntitlement | null = null;

  constructor(private readonly config: ConfigService) {
    this.licenseKey = process.env.BETTERDB_LICENSE_KEY || null;
    this.entitlementUrl = process.env.ENTITLEMENT_URL || 'https://betterdb.com/api/v1/entitlements';
    this.cacheTtlMs = parseInt(process.env.LICENSE_CACHE_TTL_MS || '3600000', 10);
    this.maxStaleCacheMs = parseInt(process.env.LICENSE_MAX_STALE_MS || '604800000', 10);
    this.timeoutMs = parseInt(process.env.LICENSE_TIMEOUT_MS || '10000', 10);
  }

  async onModuleInit() {
    await this.validateLicense();
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
      version: process.env.npm_package_version || 'unknown',
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
    };
  }

  private getCommunityEntitlement(error?: string): EntitlementResponse {
    return {
      valid: !error,
      tier: Tier.community,
      instanceLimit: TIER_INSTANCE_LIMITS[Tier.community],
      retentionLimits: TIER_RETENTION_LIMITS[Tier.community],
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
    return this.validateLicense();
  }
}
