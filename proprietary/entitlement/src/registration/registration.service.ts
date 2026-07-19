import { Injectable, Logger } from '@nestjs/common';
import { Customer, License } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { EmailService } from '../email/email.service';

type CustomerWithLicenses = Customer & { licenses: License[] };

// Self-serve licenses expire after 3 months. Re-registering renews the
// existing license for another 3 months from now — expiry keeps users in
// touch without ever locking them out permanently.
const LICENSE_VALIDITY_MONTHS = 3;

function licenseExpiry(): Date {
  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + LICENSE_VALIDITY_MONTHS);
  return expiry;
}

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly email: EmailService,
  ) {}

  async register(rawEmailAddress: string): Promise<{ message: string }> {
    const emailAddress = rawEmailAddress.trim().toLowerCase();
    let customer: CustomerWithLicenses;
    let isNew = false;

    try {
      // Check for existing customer
      const existing = await this.prisma.customer.findUnique({
        where: { email: emailAddress },
        include: { licenses: true },
      });

      if (existing) {
        customer = existing;
      } else {
        const created = await this.admin.createCustomer({ email: emailAddress });
        customer = { ...created, licenses: [] };
        isNew = true;
      }
    } catch (error: any) {
      // Handle TOCTOU race: concurrent insert for same email triggers P2002
      if (error?.code === 'P2002') {
        const existing = await this.prisma.customer.findUnique({
          where: { email: emailAddress },
          include: { licenses: true },
        });
        if (!existing) throw error; // Shouldn't happen, but be safe
        customer = existing;
      } else {
        throw error;
      }
    }

    if (isNew) {
      // Create enterprise license — 3-month validity, unlimited instances
      const license = await this.admin.createLicense({
        customerId: customer.id,
        tier: 'enterprise',
        expiresAt: licenseExpiry(),
      });

      this.logger.log(`New registration: ${customer.id} (${emailAddress}) — license ${license.id}`);
      await this.email.sendRegistrationEmail(emailAddress, license.key);

      return { message: 'Check your email for your license key' };
    }

    // Existing customer re-registering
    this.logger.log(`Existing customer re-registered: ${customer.id} (${emailAddress})`);

    const license = customer.licenses.find(
      (l) => l.active && l.tier === 'enterprise',
    );

    if (license) {
      // Renew self-serve licenses for another validity window (also un-expires
      // lapsed ones — re-registering is the self-serve renewal path). Only ever
      // EXTEND: perpetual licenses (expiresAt null, e.g. paid/manually issued)
      // are never given an expiry, and a longer paid expiry is never shortened.
      const renewal = licenseExpiry();
      if (license.expiresAt && license.expiresAt < renewal) {
        await this.admin.updateLicense(license.id, { expiresAt: renewal });
        this.logger.log(`Renewed license ${license.id} for ${emailAddress}`);
      }
      await this.email.sendRegistrationEmail(emailAddress, license.key);
      return { message: 'Check your email for your license key' };
    }

    // No active enterprise license — create a new one
    const newLicense = await this.admin.createLicense({
      customerId: customer.id,
      tier: 'enterprise',
      expiresAt: licenseExpiry(),
    });

    this.logger.log(`Re-registration created new license: ${customer.id} (${emailAddress}) — license ${newLicense.id}`);
    await this.email.sendRegistrationEmail(emailAddress, newLicense.key);

    return { message: 'Check your email for your license key' };
  }
}
