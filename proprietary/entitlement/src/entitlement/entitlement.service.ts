import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Tier, parseTier } from '@betterdb/shared';
import type { EntitlementResponse, EntitlementRequest } from '@betterdb/shared';

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(private readonly prisma: PrismaService) { }

  /**
   * Handle keyless instance requests - returns Community tier entitlements.
   */
  async handleKeylessInstance(req: EntitlementRequest): Promise<EntitlementResponse> {
    const { instanceId, stats = {} } = req;

    this.logger.log(`Keyless instance ping: ${instanceId}`, {
      version: stats.version ?? 'unknown',
      platform: stats.platform ?? 'unknown',
      arch: stats.arch ?? 'unknown',
    });

    return {
      valid: true,
      tier: Tier.community,
      expiresAt: null,
    };
  }

  /**
   * Handle cloud instance requests - resolve license via tenant → customer → license.
   */
  async handleCloudInstance(req: EntitlementRequest): Promise<EntitlementResponse> {
    const { tenantId, instanceId } = req;

    if (!tenantId) {
      this.logger.warn(`Cloud instance ${instanceId} missing tenantId`);
      return { valid: true, tier: Tier.community, expiresAt: null };
    }

    // tenantId is the DB_SCHEMA value, e.g. "tenant_mysubdomain"
    // Look up tenant by db_schema to find the linked customer and license
    const tenant = await this.prisma.tenant.findFirst({
      where: { dbSchema: tenantId },
      include: {
        customer: {
          include: {
            licenses: {
              where: { active: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!tenant?.customer) {
      this.logger.warn(`Cloud tenant ${tenantId} has no linked customer`);
      return { valid: true, tier: Tier.community, expiresAt: null };
    }

    const license = tenant.customer.licenses[0];
    if (!license) {
      this.logger.warn(`Cloud tenant ${tenantId} customer has no active license`);
      return { valid: true, tier: Tier.community, expiresAt: null };
    }

    if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
      this.logger.warn(`Cloud tenant ${tenantId} license expired`);
      return {
        valid: false,
        tier: Tier.community,
        expiresAt: license.expiresAt.toISOString(),
        error: 'License has expired',
      };
    }

    this.logger.log(`Cloud tenant ${tenantId} validated: ${license.tier}`);
    const tier = parseTier(license.tier);
    return {
      valid: true,
      tier,
      expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
      customer: {
        id: tenant.customer.id,
        name: tenant.customer.name,
        email: tenant.customer.email,
      },
    };
  }

  async validateLicense(req: EntitlementRequest): Promise<EntitlementResponse> {
    const { licenseKey } = req;

    if (!licenseKey) {
      throw new UnauthorizedException('License key is required');
    }

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
        tier: Tier.community,
        expiresAt: null,
        error: 'License has been deactivated',
      };
    }

    if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
      this.logger.warn(`Expired license: ${license.id}`);
      return {
        valid: false,
        tier: Tier.community,
        expiresAt: license.expiresAt.toISOString(),
        error: 'License has expired',
      };
    }

    this.logger.log(`License validated: ${license.id} (${license.tier})`);

    const tier = parseTier(license.tier);
    return {
      valid: true,
      tier,
      expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
      customer: {
        id: license.customer.id,
        name: license.customer.name,
        email: license.customer.email,
      },
    };
  }
}
