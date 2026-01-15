import { Injectable, Logger, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Tier } from '@prisma/client';
import {
  TIER_FEATURES,
  TIER_INSTANCE_LIMITS,
} from '../../../../proprietary/license/shared-types';

interface ValidateRequest {
  licenseKey: string;
  instanceId?: string;
  stats?: {
    version?: string;
    platform?: string;
    nodeVersion?: string;
    uptime?: number;
  };
}

interface EntitlementResponse {
  valid: boolean;
  tier: string;
  features: string[];
  instanceLimit: number;
  expiresAt: string | null;
  customer?: {
    id: string;
    name: string | null;
    email: string;
  };
  error?: string;
}

const VALIDATION_LOG_INTERVAL_MS = 60000;

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);
  private lastValidationLog = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  async validateLicense(req: ValidateRequest): Promise<EntitlementResponse> {
    const { licenseKey, instanceId, stats } = req;
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

    if (instanceId) {
      const uniqueInstances = await this.getUniqueInstanceCount(license.id);
      const isNewInstance = !(await this.hasInstanceValidated(license.id, instanceId));

      if (isNewInstance && uniqueInstances >= license.instanceLimit) {
        this.logger.warn(
          `Instance limit exceeded for license ${license.id}: ${uniqueInstances}/${license.instanceLimit}`,
        );
        throw new ForbiddenException(
          `Instance limit exceeded (${uniqueInstances}/${license.instanceLimit}). Please upgrade your license.`,
        );
      }

      await this.logValidation(license.id, instanceId, stats);
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

  private async getUniqueInstanceCount(licenseId: string): Promise<number> {
    const validations = await this.prisma.licenseValidation.groupBy({
      by: ['instanceId'],
      where: { licenseId },
    });
    return validations.length;
  }

  private async hasInstanceValidated(licenseId: string, instanceId: string): Promise<boolean> {
    const count = await this.prisma.licenseValidation.count({
      where: { licenseId, instanceId },
    });
    return count > 0;
  }

  private async logValidation(
    licenseId: string,
    instanceId: string,
    stats?: ValidateRequest['stats'],
  ): Promise<void> {
    const cacheKey = `${licenseId}:${instanceId}`;
    const lastLog = this.lastValidationLog.get(cacheKey) || 0;
    const now = Date.now();

    if (now - lastLog < VALIDATION_LOG_INTERVAL_MS) {
      return;
    }

    await this.prisma.licenseValidation.create({
      data: {
        licenseId,
        instanceId,
        version: stats?.version,
        platform: stats?.platform,
        nodeVersion: stats?.nodeVersion,
      },
    });

    this.lastValidationLog.set(cacheKey, now);
  }

  async getLicenseStats(licenseId: string, limit = 100, offset = 0) {
    const [validations, totalCount, uniqueInstances] = await Promise.all([
      this.prisma.licenseValidation.findMany({
        where: { licenseId },
        orderBy: { validatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.licenseValidation.count({ where: { licenseId } }),
      this.getUniqueInstanceCount(licenseId),
    ]);

    return {
      totalValidations: totalCount,
      uniqueInstances,
      lastValidation: validations[0]?.validatedAt || null,
      validations,
      pagination: {
        limit,
        offset,
        total: totalCount,
        hasMore: offset + limit < totalCount,
      },
    };
  }
}
