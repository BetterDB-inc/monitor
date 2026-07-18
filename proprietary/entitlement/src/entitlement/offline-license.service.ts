import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Tier, parseTier } from '@betterdb/shared';
import { LicenseSigningService } from './license-signing.service';

// Perpetual (expiresAt: null) licenses still get a finite offline token so a
// lost/leaked token eventually dies; customers re-download to renew.
const OFFLINE_MAX_VALIDITY_MS = 366 * 24 * 60 * 60 * 1000;

const OFFLINE_ELIGIBLE_TIERS: Tier[] = [Tier.pro, Tier.enterprise];

export interface CustomerLicenseSummary {
  id: string;
  tier: Tier;
  instanceLimit: number;
  expiresAt: string | null;
  active: boolean;
  keyLast4: string;
  offlineEligible: boolean;
}

export interface OfflineLicenseFile {
  token: string;
  expiresAt: string;
  kid: string;
  filename: string;
}

@Injectable()
export class OfflineLicenseService {
  private readonly logger = new Logger(OfflineLicenseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly licenseSigning: LicenseSigningService,
  ) {}

  async listLicensesByEmail(email: string): Promise<CustomerLicenseSummary[]> {
    // All emails are stored normalized (lowercase) with a UNIQUE INDEX ON
    // LOWER(email), so an exact lowercased equality is both correct and
    // index-served — unlike `mode:'insensitive'` (ILIKE), which seq-scans.
    const customer = await this.prisma.customer.findFirst({
      where: { email: email.trim().toLowerCase() },
      include: { licenses: { orderBy: { createdAt: 'desc' } } },
    });

    if (!customer) {
      return [];
    }

    const now = new Date();
    return customer.licenses.map((license) => {
      const tier = parseTier(license.tier);
      return {
        id: license.id,
        tier,
        instanceLimit: license.instanceLimit,
        expiresAt: license.expiresAt ? license.expiresAt.toISOString() : null,
        active: license.active,
        keyLast4: license.key.slice(-4),
        offlineEligible:
          license.active &&
          OFFLINE_ELIGIBLE_TIERS.includes(tier) &&
          (!license.expiresAt || license.expiresAt > now) &&
          this.licenseSigning.isConfigured,
      };
    });
  }

  /**
   * Reveal the full license key to its owner (betterdb.com shows it on the
   * licenses page after a verified-session request). Ownership is re-checked
   * here so the admin credential alone can't leak an arbitrary key to the
   * wrong account.
   */
  async revealLicenseKey(licenseId: string, requestedByEmail: string): Promise<{ key: string }> {
    const license = await this.prisma.license.findUnique({
      where: { id: licenseId },
      include: { customer: true },
    });

    if (!license) {
      throw new NotFoundException(`License ${licenseId} not found`);
    }
    if (license.customer.email.toLowerCase() !== requestedByEmail.toLowerCase()) {
      throw new ForbiddenException('License does not belong to this customer');
    }

    // The raw key is perpetual and reusable — every reveal is audited.
    await this.prisma.licenseKeyReveal.create({
      data: {
        licenseId: license.id,
        // Durable identifier that survives a license delete (which nulls licenseId)
        licenseKeyLast4: license.key.slice(-4),
        revealedToEmail: requestedByEmail.toLowerCase(),
      },
    });
    this.logger.log(`Revealed license key for ${license.id}`);

    return { key: license.key };
  }

  async issueOfflineToken(licenseId: string, requestedByEmail: string): Promise<OfflineLicenseFile> {
    const license = await this.prisma.license.findUnique({
      where: { id: licenseId },
      include: { customer: true },
    });

    if (!license) {
      throw new NotFoundException(`License ${licenseId} not found`);
    }
    if (license.customer.email.toLowerCase() !== requestedByEmail.toLowerCase()) {
      throw new ForbiddenException('License does not belong to this customer');
    }
    if (!license.active) {
      throw new BadRequestException('License has been deactivated');
    }
    const tier = parseTier(license.tier);
    if (!OFFLINE_ELIGIBLE_TIERS.includes(tier)) {
      throw new BadRequestException('Offline licenses are available for Pro and Enterprise tiers only');
    }
    if (license.expiresAt && license.expiresAt < new Date()) {
      throw new BadRequestException('License has expired');
    }
    if (!this.licenseSigning.isConfigured) {
      throw new ServiceUnavailableException('Offline license signing is not configured');
    }

    const maxValidity = new Date(Date.now() + OFFLINE_MAX_VALIDITY_MS);
    const expiresAt =
      license.expiresAt && license.expiresAt < maxValidity ? license.expiresAt : maxValidity;

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
        mode: 'offline',
        licenseExpiresAt: license.expiresAt ?? null,
      },
      expiresAt,
    );

    // Offline tokens are irrevocable until exp — record every issuance for
    // audit visibility.
    await this.prisma.offlineLicenseIssuance.create({
      data: {
        licenseId: license.id,
        // Durable identifier that survives a license delete (which nulls licenseId)
        licenseKeyLast4: license.key.slice(-4),
        jti: signed.jti,
        kid: signed.kid,
        // Normalized like the reveal audit so audit queries stay case-consistent
        issuedToEmail: requestedByEmail.toLowerCase(),
        expiresAt,
      },
    });

    this.logger.log(`Issued offline license token for ${license.id} (${tier}), expires ${expiresAt.toISOString()}`);

    return {
      token: signed.token,
      expiresAt: expiresAt.toISOString(),
      kid: signed.kid,
      filename: `betterdb-license-${license.id}.jwt`,
    };
  }
}
