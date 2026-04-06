import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LicenseService } from './license.service';
import { Feature, TIER_FEATURES } from './types';
import type { VersionInfo } from '@betterdb/shared';

@Controller()
export class LicenseController {
  constructor(private readonly license: LicenseService) { }

  @Get('version')
  @ApiTags('version')
  @ApiOperation({ summary: 'Get version information and update status' })
  @ApiOkResponse({ description: 'Version info with update availability' })
  getVersion(): VersionInfo {
    return this.license.getVersionInfo();
  }

  @Get('license/status')
  @ApiTags('license')
  @ApiOperation({ summary: 'Get license status and tier' })
  getStatus() {
    const info = this.license.getLicenseInfo();
    const features = TIER_FEATURES[info.tier];
    return {
      tier: info.tier,
      valid: info.valid,
      features,
      expiresAt: info.expiresAt,
      customer: info.customer,
    };
  }

  @Get('license/features')
  @ApiTags('license')
  @ApiOperation({ summary: 'Get all features and their status' })
  getFeatures() {
    const info = this.license.getLicenseInfo();
    const allFeatures = Object.values(Feature);
    const tierFeatures = TIER_FEATURES[info.tier];
    return {
      tier: info.tier,
      features: allFeatures.map(f => ({
        id: f,
        enabled: tierFeatures.includes(f),
      })),
    };
  }

  @Post('license/refresh')
  @Throttle({ default: { limit: 5, ttl: 60000 } }) // 5 requests per minute
  @ApiTags('license')
  @ApiOperation({ summary: 'Force refresh license validation' })
  @HttpCode(200)
  async refresh() {
    const info = await this.license.refreshLicense();
    return {
      tier: info.tier,
      valid: info.valid,
      refreshedAt: new Date().toISOString(),
    };
  }

  @Post('license/activate')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiTags('license')
  @ApiOperation({ summary: 'Activate a license key' })
  @HttpCode(200)
  async activate(@Body() body: { key: string }) {
    if (!body.key || typeof body.key !== 'string' || body.key.trim().length < 10) {
      throw new BadRequestException('A valid license key is required');
    }

    const info = await this.license.activateLicenseKey(body.key.trim());
    const features = TIER_FEATURES[info.tier];

    if (!info.valid) {
      const error = info.error || 'License activation failed';
      const response = {
        tier: info.tier,
        valid: info.valid,
        features,
        expiresAt: info.expiresAt,
        customer: info.customer,
        error,
      };

      if (error === 'Validation failed') {
        throw new ServiceUnavailableException(response);
      }
      throw new BadRequestException(response);
    }

    return {
      tier: info.tier,
      valid: info.valid,
      features,
      expiresAt: info.expiresAt,
      customer: info.customer,
      error: info.error,
      activatedAt: new Date().toISOString(),
    };
  }
}
