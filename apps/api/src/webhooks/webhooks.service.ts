import { Injectable, Inject, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { randomBytes, createHmac } from 'crypto';
import type { Webhook, WebhookDelivery, WebhookEventType, DEFAULT_RETRY_POLICY } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { CreateWebhookDto, UpdateWebhookDto } from '../common/dto/webhook.dto';

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
  ) {}

  /**
   * Validate webhook URL for SSRF protection
   */
  private validateUrl(url: string): void {
    try {
      const parsed = new URL(url);

      // Only allow http and https
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new BadRequestException('Only HTTP and HTTPS protocols are allowed');
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

      // Block private IP ranges
      for (const pattern of this.BLOCKED_IP_PATTERNS) {
        if (pattern.test(parsed.hostname)) {
          throw new BadRequestException('Cannot use private IP addresses as webhook URL');
        }
      }

      // Additional checks for common bypass attempts
      if (parsed.hostname.includes('127.') || parsed.hostname.includes('localhost')) {
        throw new BadRequestException('Suspicious hostname detected');
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
   * Create a new webhook
   */
  async createWebhook(dto: CreateWebhookDto): Promise<Webhook> {
    // Validate URL for SSRF
    this.validateUrl(dto.url);

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
   */
  async getAllWebhooks(): Promise<Webhook[]> {
    return this.storageClient.getWebhooksByInstance();
  }

  /**
   * Get all webhooks with redacted secrets (for API responses)
   */
  async getAllWebhooksRedacted(): Promise<Webhook[]> {
    const webhooks = await this.getAllWebhooks();
    return webhooks.map(webhook => this.redactSecret(webhook));
  }

  /**
   * Get webhooks subscribed to a specific event
   */
  async getWebhooksByEvent(event: WebhookEventType): Promise<Webhook[]> {
    return this.storageClient.getWebhooksByEvent(event);
  }

  /**
   * Update a webhook
   */
  async updateWebhook(id: string, dto: UpdateWebhookDto): Promise<Webhook> {
    // Validate URL if provided
    if (dto.url) {
      this.validateUrl(dto.url);
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
  async getDeliveries(webhookId: string, limit: number = 100): Promise<WebhookDelivery[]> {
    return this.storageClient.getDeliveriesByWebhook(webhookId, limit);
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
   * Redact webhook secret for API responses
   */
  redactSecret(webhook: Webhook): Webhook {
    if (!webhook.secret) {
      return webhook;
    }

    return {
      ...webhook,
      secret: `${webhook.secret.substring(0, 10)}***`,
    };
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
