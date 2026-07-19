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
    const claims = this.license.getVerifiedClaims();
    return {
      tier: info.tier,
      valid: info.valid,
      features,
      expiresAt: info.expiresAt,
      customer: info.customer,
      source: this.license.getLicenseSource(),
      mode: claims?.mode,
      instanceLimit: info.instanceLimit ?? claims?.instanceLimit,
      offlineExpiresAt: this.license.getOfflineExpiresAt(),
      airGapped: this.license.isAirGapped(),
      clockRollbackSuspected: this.license.isClockRollbackSuspected(),
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

  @Post('license/activate-offline')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiTags('license')
  @ApiOperation({ summary: 'Activate an offline (air-gapped) license token' })
  @HttpCode(200)
  async activateOffline(@Body() body: { token: string }) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    // A JWT is three dot-separated base64url segments
    if (!token || token.split('.').length !== 3) {
      throw new BadRequestException('A valid offline license token is required');
    }

    const { entitlement, fallbackOnly } = await this.license.activateOfflineLicense(token);
    const features = TIER_FEATURES[entitlement.tier];

    if (!entitlement.valid && !fallbackOnly) {
      throw new BadRequestException({
        tier: entitlement.tier,
        valid: entitlement.valid,
        features,
        expiresAt: entitlement.expiresAt,
        customer: entitlement.customer,
        error: entitlement.error || 'Offline license activation failed',
      });
    }

    // `entitlement` reflects what is ACTIVE after the call — with a license
    // key configured that's still the online entitlement, and the token was
    // only stored as fallback.
    return {
      tier: entitlement.tier,
      valid: entitlement.valid,
      features,
      expiresAt: entitlement.expiresAt,
      customer: entitlement.customer,
      instanceLimit: entitlement.instanceLimit,
      fallbackOnly,
      ...(fallbackOnly
        ? { message: 'Offline license stored as fallback — your online license key remains active' }
        : {}),
      activatedAt: new Date().toISOString(),
    };
  }
}
