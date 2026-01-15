import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Tier } from '@prisma/client';
import { TIER_FEATURES } from '@betterdb/shared';
import type { EntitlementResponse, EntitlementRequest } from '@betterdb/shared';

type ValidateRequest = EntitlementRequest;

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async validateLicense(req: ValidateRequest): Promise<EntitlementResponse> {
    const { licenseKey } = req;
    const keyPrefix = licenseKey.substring(0, 8);

    const license = await this.prisma.license.findUnique({
      where: { key: licenseKey },
      include: { customer: true },
    });

    if (!license) {
      this.logger.warn(`Invalid license key: ${keyPrefix}...`);
      throw new UnauthorizedException('Invalid license key');
    }

    if (!license.active) {
      this.logger.warn(`Inactive license: ${license.id}`);
      return {
        valid: false,
        tier: 'community',
        features: [],
        instanceLimit: 1,
        expiresAt: null,
        error: 'License has been deactivated',
      };
    }

    if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
      this.logger.warn(`Expired license: ${license.id}`);
      return {
        valid: false,
        tier: 'community',
        features: [],
        instanceLimit: 1,
        expiresAt: license.expiresAt.toISOString(),
        error: 'License has expired',
      };
    }

    this.logger.log(`License validated: ${license.id} (${license.tier})`);

    return {
      valid: true,
      tier: license.tier,
      features: TIER_FEATURES[license.tier as Tier] || [],
      instanceLimit: license.instanceLimit,
      expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
      customer: {
        id: license.customer.id,
        name: license.customer.name,
        email: license.customer.email,
      },
    };
  }
}
