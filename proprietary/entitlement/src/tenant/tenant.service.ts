import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantStatus } from '@prisma/client';

const RESERVED_SUBDOMAINS = [
  'www', 'api', 'app', 'admin', 'system', 'test', 'staging', 'prod',
  'mail', 'smtp', 'ftp', 'ns1', 'ns2', 'status', 'docs', 'blog',
  'support', 'help',
];

@Injectable()
export class TenantService {
  private readonly logger = new Logger(TenantService.name);

  constructor(private readonly prisma: PrismaService) { }

  async createTenant(data: { name: string; subdomain: string; email: string; imageTag?: string; domain?: string }) {
    const subdomain = data.subdomain.toLowerCase();

    // Validate subdomain format
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(subdomain) || subdomain.length < 3 || subdomain.length > 30) {
      throw new BadRequestException(
        'Subdomain must be 3-30 characters, lowercase alphanumeric with hyphens, starting and ending with alphanumeric',
      );
    }

    // Check reserved subdomains
    if (RESERVED_SUBDOMAINS.includes(subdomain)) {
      throw new BadRequestException(`Subdomain '${subdomain}' is reserved`);
    }

    // Check uniqueness
    const existing = await this.getTenantBySubdomain(subdomain);
    if (existing) {
      throw new ConflictException(`Subdomain '${subdomain}' is already taken`);
    }

    // Handle domain (lowercase and check uniqueness)
    const domain = data.domain?.toLowerCase() || null;
    if (domain) {
      const existingDomain = await this.getTenantByDomain(domain);
      if (existingDomain) {
        throw new ConflictException(`Domain '${domain}' is already associated with a tenant`);
      }
    }

    // Derive dbSchema from subdomain (replace hyphens with underscores for valid PG identifier)
    const dbSchema = `tenant_${subdomain.replace(/-/g, '_')}`;

    // Use provided imageTag, fall back to env var, or use hardcoded default
    const imageTag = data.imageTag || process.env.DEFAULT_IMAGE_TAG || 'v0.6.0';

    const tenant = await this.prisma.tenant.create({
      data: {
        name: data.name,
        subdomain,
        email: data.email,
        dbSchema,
        imageTag,
        domain,
        status: 'pending',
      },
    });

    this.logger.log(`Created tenant: ${tenant.id} (${tenant.subdomain}) with imageTag: ${imageTag}`);
    return tenant;
  }

  async listTenants(params?: { status?: TenantStatus; skip?: number; take?: number }) {
    return this.prisma.tenant.findMany({
      where: params?.status ? { status: params.status } : undefined,
      skip: params?.skip || 0,
      take: params?.take || 50,
      include: {
        customer: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getTenant(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        customer: true,
      },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant ${id} not found`);
    }

    return tenant;
  }

  async getTenantBySubdomain(subdomain: string) {
    return this.prisma.tenant.findUnique({
      where: { subdomain: subdomain.toLowerCase() },
      include: {
        customer: true,
      },
    });
  }

  async getTenantByDomain(domain: string) {
    return this.prisma.tenant.findUnique({
      where: { domain: domain.toLowerCase() },
      include: {
        customer: true,
      },
    });
  }

  async updateTenantStatus(id: string, status: TenantStatus, statusMessage?: string) {
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: {
        status,
        statusMessage: statusMessage || null,
      },
    });

    this.logger.log(`Updated tenant ${id} status to ${status}`);
    return tenant;
  }

  async updateTenant(id: string, data: { name?: string; email?: string; imageTag?: string }) {
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data,
    });

    this.logger.log(`Updated tenant: ${id}`);
    return tenant;
  }

  async deleteTenant(id: string) {
    // Soft delete by setting status to 'deleting'
    // Hard delete will be handled by the deprovision pipeline in Phase 4b
    const tenant = await this.prisma.tenant.update({
      where: { id },
      data: {
        status: 'deleting',
      },
    });

    this.logger.log(`Marked tenant ${id} for deletion`);
    return tenant;
  }
}
