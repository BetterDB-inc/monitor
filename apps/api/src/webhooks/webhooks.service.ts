import { Injectable, Inject, Logger, BadRequestException, NotFoundException, ForbiddenException, Optional } from '@nestjs/common';
import { randomBytes, createHmac } from 'crypto';
import { promises as dns } from 'dns';
import type { Webhook, WebhookDelivery, WebhookEventType, DEFAULT_RETRY_POLICY } from '@betterdb/shared';
import { Tier, validateEventsForTier, getRequiredTierForEvent, getEventsForTier, getLockedEventsForTier } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { CreateWebhookDto, UpdateWebhookDto } from '../common/dto/webhook.dto';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { LicenseService } from '@proprietary/license';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  // SSRF Protection: Private IP ranges to block
  private readonly BLOCKED_IP_PATTERNS = [
    /^127\./,                    // localhost
    /^10\./,                     // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
    /^192\.168\./,               // 192.168.0.0/16
    /^169\.254\./,               // link-local
    /^::1$/,                     // IPv6 localhost
    /^fe80:/,                    // IPv6 link-local
    /^fc00:/,                    // IPv6 unique local
  ];

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
    @Optional() private readonly licenseService?: LicenseService,
  ) { }

  /**
   * Resolve connectionId to default if not provided.
   * Falls back to default connection when available, otherwise returns undefined.
   */
  private resolveConnectionId(connectionId?: string): string | undefined {
    return connectionId || this.connectionRegistry.getDefaultId() || undefined;
  }

  /**
   * Check if an IP address is blocked
   */
  private isBlockedIp(ip: string): boolean {
    for (const pattern of this.BLOCKED_IP_PATTERNS) {
      if (pattern.test(ip)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Validate webhook URL for SSRF protection
   */
  private async validateUrl(url: string): Promise<void> {
    try {
      const parsed = new URL(url);

      // Only allow http and https
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new BadRequestException('Only HTTP and HTTPS protocols are allowed');
      }

      // Warn if URL contains credentials
      if (parsed.username || parsed.password) {
        this.logger.warn(`Webhook URL contains credentials, consider using custom headers instead: ${parsed.hostname}`);
      }

      // Allow localhost in development/non-production environments
      const isProduction = process.env.NODE_ENV === 'production';
      const isLocalhost = parsed.hostname === 'localhost' ||
        parsed.hostname === '0.0.0.0' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname.startsWith('127.');

      if (isLocalhost && !isProduction) {
        // Allow localhost in development
        this.logger.debug(`Allowing localhost webhook URL in ${process.env.NODE_ENV || 'development'} mode: ${url}`);
        return;
      }

      // Block localhost in production
      if (parsed.hostname === 'localhost' || parsed.hostname === '0.0.0.0') {
        throw new BadRequestException('Cannot use localhost or 0.0.0.0 as webhook URL in production');
      }

      // Check if hostname is already an IP
      if (this.isBlockedIp(parsed.hostname)) {
        throw new BadRequestException('Cannot use private IP addresses as webhook URL');
      }

      // Additional checks for common bypass attempts
      if (parsed.hostname.includes('127.') || parsed.hostname.includes('localhost')) {
        throw new BadRequestException('Suspicious hostname detected');
      }

      // DNS resolution to prevent DNS rebinding attacks
      if (isProduction) {
        try {
          const addresses = await dns.resolve(parsed.hostname);
          for (const addr of addresses) {
            if (this.isBlockedIp(addr)) {
              throw new BadRequestException(`Webhook URL resolves to blocked IP address: ${addr}`);
            }
          }
        } catch (dnsError: any) {
          // If DNS resolution fails, it might be unreachable but not necessarily malicious
          if (dnsError instanceof BadRequestException) {
            throw dnsError;
          }
          this.logger.warn(`Failed to resolve DNS for webhook URL: ${parsed.hostname}`);
          throw new BadRequestException('Failed to resolve webhook URL hostname');
        }
      }

    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException('Invalid webhook URL');
    }
  }

  /**
   * Generate a secure webhook secret
   */
  generateSecret(): string {
    return `whsec_${randomBytes(32).toString('hex')}`;
  }

  /**
   * Generate HMAC signature for webhook payload
   */
  generateSignature(payload: string, secret: string): string {
    return createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  /**
   * Verify webhook signature
   */
  verifySignature(payload: string, signature: string, secret: string): boolean {
    const expectedSignature = this.generateSignature(payload, secret);
    return signature === expectedSignature;
  }

  /**
   * Validate that requested events are allowed for the user's license tier
   * @throws ForbiddenException if any events are not allowed
   */
  private validateEventTiers(events: WebhookEventType[]): void {
    // If no license service available, default to community tier
    const userTier: Tier = this.licenseService?.getLicenseTier() || Tier.community;

    // Check which events are not allowed
    const disallowedEvents = validateEventsForTier(events, userTier);

    if (disallowedEvents.length > 0) {
      const eventDetails = disallowedEvents.map(event => {
        const requiredTier = getRequiredTierForEvent(event);
        return `${event} (requires ${requiredTier.toUpperCase()} tier)`;
      }).join(', ');

      throw new ForbiddenException(
        `Your ${userTier.toUpperCase()} tier does not have access to the following events: ${eventDetails}. ` +
        `Please upgrade your license to subscribe to these events.`
      );
    }
  }

  /**
   * Create a new webhook
   */
  async createWebhook(dto: CreateWebhookDto & { connectionId?: string }): Promise<Webhook> {
    // Validate URL for SSRF
    await this.validateUrl(dto.url);

    // Validate event tier access
    this.validateEventTiers(dto.events);

    // Generate secret if not provided
    const secret = dto.secret || this.generateSecret();

    // Set default retry policy if not provided
    const retryPolicy = dto.retryPolicy || {
      maxRetries: 3,
      backoffMultiplier: 2,
      initialDelayMs: 1000,
      maxDelayMs: 60000,
    };

    const webhook = await this.storageClient.createWebhook({
      name: dto.name,
      url: dto.url,
      secret,
      enabled: dto.enabled ?? true,
      events: dto.events,
      headers: dto.headers || {},
      retryPolicy,
      deliveryConfig: dto.deliveryConfig,
      alertConfig: dto.alertConfig,
      thresholds: dto.thresholds,
      connectionId: this.resolveConnectionId(dto.connectionId),
    });

    this.logger.log(`Webhook created: ${webhook.id} - ${webhook.name}`);
    return webhook;
  }

  /**
   * Get a webhook by ID
   */
  async getWebhook(id: string): Promise<Webhook> {
    const webhook = await this.storageClient.getWebhook(id);
    if (!webhook) {
      throw new NotFoundException(`Webhook with ID ${id} not found`);
    }
    return webhook;
  }

  /**
   * Get webhook with redacted secret (for API responses)
   */
  async getWebhookRedacted(id: string): Promise<Webhook> {
    const webhook = await this.getWebhook(id);
    return this.redactSecret(webhook);
  }

  /**
   * Get all webhooks for the current instance
   * Falls back to default connection if no connectionId provided
   */
  async getAllWebhooks(connectionId?: string): Promise<Webhook[]> {
    return this.storageClient.getWebhooksByInstance(this.resolveConnectionId(connectionId));
  }

  /**
   * Get all webhooks with redacted secrets (for API responses)
   */
  async getAllWebhooksRedacted(connectionId?: string): Promise<Webhook[]> {
    const webhooks = await this.getAllWebhooks(connectionId);
    return webhooks.map(webhook => this.redactSecret(webhook));
  }

  /**
   * Get webhooks subscribed to a specific event
   * @param event The event type to filter by
   * @param connectionId Optional connection ID to filter webhooks (falls back to default)
   */
  async getWebhooksByEvent(event: WebhookEventType, connectionId?: string): Promise<Webhook[]> {
    return this.storageClient.getWebhooksByEvent(event, this.resolveConnectionId(connectionId));
  }

  /**
   * Update a webhook
   */
  async updateWebhook(id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    // Validate URL if provided
    if (dto.url) {
      await this.validateUrl(dto.url);
    }

    // Validate event tier access if events are being updated
    if (dto.events) {
      this.validateEventTiers(dto.events);
    }

    const updated = await this.storageClient.updateWebhook(id, dto);
    if (!updated) {
      throw new NotFoundException(`Webhook with ID ${id} not found`);
    }

    this.logger.log(`Webhook updated: ${id}`);
    return updated;
  }

  /**
   * Delete a webhook
   */
  async deleteWebhook(id: string): Promise<void> {
    const deleted = await this.storageClient.deleteWebhook(id);
    if (!deleted) {
      throw new NotFoundException(`Webhook with ID ${id} not found`);
    }

    this.logger.log(`Webhook deleted: ${id}`);
  }

  /**
   * Get webhook deliveries
   */
  async getDeliveries(webhookId: string, limit: number = 100, offset: number = 0): Promise<WebhookDelivery[]> {
    return this.storageClient.getDeliveriesByWebhook(webhookId, limit, offset);
  }

  /**
   * Get a single delivery by ID
   */
  async getDelivery(id: string): Promise<WebhookDelivery> {
    const delivery = await this.storageClient.getDelivery(id);
    if (!delivery) {
      throw new NotFoundException(`Delivery with ID ${id} not found`);
    }
    return delivery;
  }

  /**
   * Get allowed and locked events for the user's tier
   */
  getAllowedEvents(): {
    tier: Tier;
    allowedEvents: WebhookEventType[];
    lockedEvents: WebhookEventType[];
  } {
    const tier: Tier = this.licenseService?.getLicenseTier() || Tier.community;
    const allowedEvents = getEventsForTier(tier);
    const lockedEvents = getLockedEventsForTier(tier);

    return {
      tier,
      allowedEvents,
      lockedEvents,
    };
  }

  /**
   * Redact webhook secret for API responses
   * Shows only a small prefix to help identify the secret without revealing it
   */
  redactSecret(webhook: Webhook): Webhook {
    if (!webhook.secret) {
      return webhook;
    }

    const secret = webhook.secret;
    let redacted: string;

    if (secret.startsWith('whsec_')) {
      // For whsec_ prefixed secrets, show prefix + up to 4 chars
      const rest = secret.slice(6);
      const visibleChars = Math.min(4, rest.length);
      redacted = `whsec_${rest.substring(0, visibleChars)}***`;
    } else {
      // For other secrets, show 2-4 chars based on length
      const visibleChars = secret.length < 8 ? 2 : 4;
      redacted = `${secret.substring(0, Math.min(visibleChars, secret.length))}***`;
    }

    return { ...webhook, secret: redacted };
  }

  /**
   * Prune old deliveries (called by background job)
   */
  async pruneOldDeliveries(retentionDays: number = 30): Promise<number> {
    const cutoffTimestamp = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const pruned = await this.storageClient.pruneOldDeliveries(cutoffTimestamp);

    if (pruned > 0) {
      this.logger.log(`Pruned ${pruned} old webhook deliveries older than ${retentionDays} days`);
    }

    return pruned;
  }
}
