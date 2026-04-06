import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly apiKey: string | undefined;
  private readonly fromEmail: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('RESEND_API_KEY');
    this.fromEmail = this.config.get<string>('RESEND_FROM_EMAIL', 'Kristiyan <kristiyan@betterdb.com>');

    if (!this.apiKey) {
      this.logger.warn('RESEND_API_KEY not set — emails will be logged but not sent');
    }
  }

  async sendRegistrationEmail(to: string, licenseKey: string): Promise<void> {
    const subject = 'Your BetterDB license key';
    const text = `Hi,

Here's your BetterDB Enterprise license key:

${licenseKey}

SELF-HOSTED
Set this environment variable wherever you run BetterDB Monitor:

  BETTERDB_LICENSE_KEY=${licenseKey}

Or paste it in Settings > License > "Already have a license key?"

CLOUD
No action needed — your license is automatically applied to your workspace.

This unlocks every Pro and Enterprise feature at no cost during early access,
plus extended free access even if pricing changes.

Kristiyan
BetterDB`;

    if (!this.apiKey) {
      this.logger.log(`[DEV] Would send registration email to ${to}`);
      this.logger.log(`[DEV] License key: ${licenseKey}`);
      return;
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to,
          subject,
          text,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        this.logger.error(`Failed to send email to ${to}: ${response.status} ${error}`);
        throw new Error(`Email delivery failed: ${response.status}`);
      }

      this.logger.log(`Registration email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${to}:`, error);
      throw error;
    }
  }
}
