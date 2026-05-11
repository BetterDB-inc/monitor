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

  async sendWelcomeEmail(to: string, workspaceUrl: string): Promise<void> {
    const subject = 'Welcome to BetterDB';
    const text = `Hey,

I'm Kristiyan, founder and CTO of BetterDB and an expert on Valkey and Redis - I spent the last few years running Redis Insight at Redis Inc., so if you ever have questions about your setup, I'm happy to help directly.

Your workspace is live at ${workspaceUrl}. BetterDB works with both Valkey and Redis. It persists your slowlog, COMMANDLOG, latency history, client analytics, and ACL audit trail so you can debug incidents hours after they happen, not just in real time.

To get started, connect your first instance from the dashboard.

If you're running a managed or private deployment (ElastiCache, MemoryDB, GCP Memorystore, or an instance not directly reachable from the internet), you'll also need the BetterDB agent:
- Docker: https://hub.docker.com/r/betterdb/agent
- npm: https://www.npmjs.com/package/@betterdb/agent

Just reply to this email if you need anything - even if it's a Valkey or Redis question that has nothing to do with BetterDB.

P.S. We recently released chat.betterdb.com - a public OSS chat trained on Valkey, Redis, Dragonfly and our own docs, so you can use it to cross check the docs more easily and evaluate the differences. It also showcases our LLM caching libraries in action.

Kristiyan
Founder and CTO, BetterDB`;

    if (!this.apiKey) {
      this.logger.log(`[DEV] Would send welcome email to ${to} (workspace: ${workspaceUrl})`);
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
        this.logger.error(`Failed to send welcome email to ${to}: ${response.status} ${error}`);
        throw new Error(`Email delivery failed: ${response.status}`);
      }

      this.logger.log(`Welcome email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send welcome email to ${to}:`, error);
      throw error;
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
      this.logger.debug(`[DEV] License key: ${licenseKey.slice(0, 8)}...`);
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
