import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly email: EmailService,
  ) {}

  async register(emailAddress: string): Promise<{ message: string }> {
    // Check for existing customer
    const existing = await this.prisma.customer.findUnique({
      where: { email: emailAddress },
      include: { licenses: true },
    });

    if (existing) {
      this.logger.log(`Existing customer re-registered: ${existing.id} (${emailAddress})`);

      // Find their active enterprise license
      const license = existing.licenses.find((l) => l.active && l.tier === 'enterprise');
      if (license) {
        // Resend the email with their existing key
        await this.email.sendRegistrationEmail(emailAddress, license.key);
      }

      return { message: 'Check your email for your license key' };
    }

    // Create new customer
    const customer = await this.admin.createCustomer({ email: emailAddress });

    // Create enterprise license — no expiry, unlimited instances
    const license = await this.admin.createLicense({
      customerId: customer.id,
      tier: 'enterprise',
    });

    this.logger.log(`New registration: ${customer.id} (${emailAddress}) — license ${license.id}`);

    // Send the registration email
    await this.email.sendRegistrationEmail(emailAddress, license.key);

    return { message: 'Check your email for your license key' };
  }
}
