import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';
import { TIER_INSTANCE_LIMITS } from '../../../../proprietary/license/shared-types';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createCustomer(data: { email: string; name?: string }) {
    const customer = await this.prisma.customer.create({
      data: {
        email: data.email,
        name: data.name,
      },
    });

    this.logger.log(`Created customer: ${customer.id} (${customer.email})`);
    return customer;
  }

  async listCustomers(params?: { skip?: number; take?: number }) {
    return this.prisma.customer.findMany({
      skip: params?.skip || 0,
      take: params?.take || 50,
      include: {
        licenses: true,
        subscriptions: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCustomer(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        licenses: true,
        subscriptions: true,
      },
    });

    if (!customer) {
      throw new NotFoundException(`Customer ${id} not found`);
    }

    return customer;
  }

  async createLicense(data: {
    customerId: string;
    tier: string;
    instanceLimit?: number;
    expiresAt?: Date;
  }) {
    const licenseKey = this.generateLicenseKey();

    const license = await this.prisma.license.create({
      data: {
        key: licenseKey,
        customerId: data.customerId,
        tier: data.tier,
        instanceLimit: data.instanceLimit || this.getDefaultInstanceLimit(data.tier),
        expiresAt: data.expiresAt,
        active: true,
      },
    });

    this.logger.log(`Created license: ${license.id} (${license.tier})`);
    return license;
  }

  async listLicenses(params?: { customerId?: string; skip?: number; take?: number }) {
    return this.prisma.license.findMany({
      where: params?.customerId ? { customerId: params.customerId } : undefined,
      skip: params?.skip || 0,
      take: params?.take || 50,
      include: {
        customer: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getLicense(id: string) {
    const license = await this.prisma.license.findUnique({
      where: { id },
      include: {
        customer: true,
      },
    });

    if (!license) {
      throw new NotFoundException(`License ${id} not found`);
    }

    return license;
  }

  async updateLicense(id: string, data: { active?: boolean; expiresAt?: Date; instanceLimit?: number }) {
    const license = await this.prisma.license.update({
      where: { id },
      data,
    });

    this.logger.log(`Updated license: ${id}`);
    return license;
  }

  async deleteLicense(id: string) {
    await this.prisma.license.delete({
      where: { id },
    });

    this.logger.log(`Deleted license: ${id}`);
    return { success: true };
  }

  async getLicenseStats(licenseId: string) {
    const validations = await this.prisma.licenseValidation.findMany({
      where: { licenseId },
      orderBy: { validatedAt: 'desc' },
      take: 100,
    });

    const uniqueInstances = new Set(validations.map((v) => v.instanceId)).size;
    const lastValidation = validations[0]?.validatedAt || null;

    return {
      totalValidations: validations.length,
      uniqueInstances,
      lastValidation,
      recentValidations: validations.slice(0, 10),
    };
  }

  private generateLicenseKey(): string {
    return `btdb_${randomBytes(16).toString('hex')}`;
  }

  private getDefaultInstanceLimit(tier: string): number {
    const limit = TIER_INSTANCE_LIMITS[tier as keyof typeof TIER_INSTANCE_LIMITS];
    return Number.isFinite(limit) ? limit : 1;
  }
}
