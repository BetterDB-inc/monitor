import { Controller, Get, Post, HttpCode } from '@nestjs/common';
import { LicenseService } from './license.service';
import { Feature, TIER_FEATURES } from './types';

@Controller('license')
export class LicenseController {
  constructor(private readonly license: LicenseService) {}

  @Get('status')
  getStatus() {
    const info = this.license.getLicenseInfo();
    // Derive features from tier using TIER_FEATURES mapping
    const features = TIER_FEATURES[info.tier];
    return {
      tier: info.tier,
      valid: info.valid,
      features,
      instanceLimit: info.instanceLimit,
      retentionLimits: info.retentionLimits,
      expiresAt: info.expiresAt,
      customer: info.customer,
    };
  }

  @Get('features')
  getFeatures() {
    const info = this.license.getLicenseInfo();
    const allFeatures = Object.values(Feature);
    // Derive enabled features from tier
    const tierFeatures = TIER_FEATURES[info.tier];
    return {
      tier: info.tier,
      features: allFeatures.map(f => ({
        id: f,
        enabled: tierFeatures.includes(f),
      })),
    };
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh() {
    const info = await this.license.refreshLicense();
    return {
      tier: info.tier,
      valid: info.valid,
      refreshedAt: new Date().toISOString(),
    };
  }
}
