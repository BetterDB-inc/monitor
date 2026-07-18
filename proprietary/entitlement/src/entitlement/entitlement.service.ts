import { Injectable, Logger, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Tier, parseTier } from '@betterdb/shared';
import type { EntitlementResponse, EntitlementRequest } from '@betterdb/shared';
import { LicenseSigningService } from './license-signing.service';

// Online entitlement tokens double as the monitor's tamper-proof stale-cache
// fallback, so their lifetime mirrors the monitor's LICENSE_MAX_STALE_MS (7d).
const ONLINE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly licenseSigning: LicenseSigningService,
  ) { }

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
   * Handle cloud instance requests.
   * All cloud-hosted tenants receive Enterprise tier by default — billing and
   * tier differentiation are handled at the subscription/provisioning layer,
   * so the entitlement check simply grants full access to any valid cloud tenant.
   */
  async handleCloudInstance(req: EntitlementRequest): Promise<EntitlementResponse> {
    const { tenantId, instanceId } = req;

    if (!tenantId) {
      this.logger.warn(`Cloud instance ${instanceId} missing tenantId, falling back to community`);
      return { valid: true, tier: Tier.community, expiresAt: null };
    }

    // The tenantId is the provisioned DB schema. Grant enterprise ONLY to a
    // tenant that actually exists and is in service — otherwise any client
    // could POST an arbitrary tenantId and mint a signed enterprise token.
    // (This is existence-gating, not per-tenant authentication; see the
    // follow-up note about signing per-tenant credentials into the check.)
    const tenant = await this.prisma.tenant.findFirst({
      where: { dbSchema: tenantId },
      select: { id: true, status: true },
    });

    if (!tenant || !['ready', 'provisioning'].includes(tenant.status)) {
      this.logger.warn(
        `Cloud instance ${instanceId} presented unknown/inactive tenantId "${tenantId}" — refusing enterprise grant`,
      );
      return { valid: true, tier: Tier.community, expiresAt: null };
    }

    this.logger.log(`Cloud tenant ${tenantId} granted enterprise tier`);
    const response: EntitlementResponse = {
      valid: true,
      tier: Tier.enterprise,
      expiresAt: null,
    };

    // Cloud grants must be signed like key-based ones — monitors refuse
    // unsigned paid tiers by default.
    if (this.licenseSigning.isConfigured) {
      try {
        const signed = this.licenseSigning.signLicenseToken(
          {
            licenseId: `cloud-tenant:${tenantId}`,
            tier: Tier.enterprise,
            instanceLimit: 999999,
            mode: 'online',
            licenseExpiresAt: null, // cloud enterprise grants are perpetual
          },
          new Date(Date.now() + ONLINE_TOKEN_TTL_MS),
        );
        response.token = signed.token;
        response.instanceLimit = 999999;
      } catch (error) {
        // Signing is configured but failed at request time — do NOT return a
        // valid unsigned paid grant (monitors refuse those and downgrade to
        // community). Surface a 503 so the monitor treats it as a transient
        // outage and retries against its fallback instead.
        this.logger.error(`Failed to sign cloud entitlement for ${tenantId}: ${(error as Error).message}`);
        throw new ServiceUnavailableException('Unable to issue signed entitlement token');
      }
    }

    return response;
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
      // A body-level rejection (HTTP 200 valid:false), NOT a transport error:
      // the proxy and monitor distinguish "server says this key is bad" from
      // "server/gateway unreachable" by status code, so an unknown key must
      // not surface as a 401 that infra failures also produce.
      return {
        valid: false,
        tier: Tier.community,
        expiresAt: null,
        error: 'Invalid license key',
      };
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
    const response: EntitlementResponse = {
      valid: true,
      tier,
      expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
      customer: {
        id: license.customer.id,
        name: license.customer.name,
        email: license.customer.email,
      },
    };

    // Attach a signed entitlement token so the monitor can verify its cached
    // entitlement offline. When signing is configured but fails at request
    // time we surface a 503 (below) rather than a valid unsigned paid grant,
    // which new monitors refuse and downgrade to community over.
    if (tier !== Tier.community && this.licenseSigning.isConfigured) {
      try {
        const expiryCandidates = [Date.now() + ONLINE_TOKEN_TTL_MS];
        if (license.expiresAt) {
          expiryCandidates.push(license.expiresAt.getTime());
        }
        const signed = this.licenseSigning.signLicenseToken(
          {
            licenseId: license.id,
            tier,
            customer: {
              id: license.customer.id,
              name: license.customer.name,
              email: license.customer.email,
            },
            instanceLimit: license.instanceLimit,
            mode: 'online',
            licenseExpiresAt: license.expiresAt ?? null,
          },
          new Date(Math.min(...expiryCandidates)),
        );
        response.token = signed.token;
        response.instanceLimit = license.instanceLimit;
      } catch (error) {
        // See handleCloudInstance: fail transiently (503) instead of returning
        // a refusable unsigned paid grant.
        this.logger.error(`Failed to sign entitlement token for ${license.id}: ${(error as Error).message}`);
        throw new ServiceUnavailableException('Unable to issue signed entitlement token');
      }
    }

    return response;
  }
}
