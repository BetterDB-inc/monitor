import { Controller, Get, Post, HttpCode } from '@nestjs/common';
import { LicenseService } from './license.service';
import { Feature } from './types';

@Controller('license')
export class LicenseController {
  constructor(private readonly license: LicenseService) {}

  @Get('status')
  getStatus() {
    const info = this.license.getLicenseInfo();
    return {
      tier: info.tier,
      valid: info.valid,
      features: info.features,
      instanceLimit: info.instanceLimit,
      expiresAt: info.expiresAt,
      customer: info.customer,
    };
  }

  @Get('features')
  getFeatures() {
    const info = this.license.getLicenseInfo();
    const allFeatures = Object.values(Feature);
    return {
      tier: info.tier,
      features: allFeatures.map(f => ({
        id: f,
        enabled: info.features.includes(f),
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
