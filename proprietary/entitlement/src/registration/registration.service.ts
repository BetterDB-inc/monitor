import { Injectable, Logger } from '@nestjs/common';
import { Customer, License } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { EmailService } from '../email/email.service';

type CustomerWithLicenses = Customer & { licenses: License[] };

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly email: EmailService,
  ) {}

  async register(emailAddress: string): Promise<{ message: string }> {
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
      // Create enterprise license — no expiry, unlimited instances
      const license = await this.admin.createLicense({
        customerId: customer.id,
        tier: 'enterprise',
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
      // Resend the email with their existing key
      await this.email.sendRegistrationEmail(emailAddress, license.key);
      return { message: 'Check your email for your license key' };
    }

    // No active enterprise license — create a new one
    const newLicense = await this.admin.createLicense({
      customerId: customer.id,
      tier: 'enterprise',
    });

    this.logger.log(`Re-registration created new license: ${customer.id} (${emailAddress}) — license ${newLicense.id}`);
    await this.email.sendRegistrationEmail(emailAddress, newLicense.key);

    return { message: 'Check your email for your license key' };
  }
}
