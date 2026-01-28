import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from 'lru-cache';
import type { Webhook, WebhookPayload, WebhookEventType } from '@betterdb/shared';
import { DeliveryStatus } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhooksService } from './webhooks.service';

interface AlertState {
  fired: boolean;
  firedAt: number;
  value: number;
}

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly REQUEST_TIMEOUT_MS: number;
  private readonly BLOCKED_HEADERS = ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade'];

  // Alert hysteresis configuration
  // 10% hysteresis prevents alert flapping - e.g., for 90% threshold:
  // - Alert fires at 90%
  // - Alert clears only when drops below 81% (90% * 0.9)
  // - This prevents oscillation around the threshold boundary
  private readonly ALERT_HYSTERESIS_FACTOR = 0.9; // 10% margin below threshold for recovery

  // Alert state cache configuration
  // Max 1000 alerts: Sufficient for typical deployments (even 100 instances × 10 metrics = 1000)
  // Exceeding 1000 means LRU evicts oldest, which is acceptable (they'll re-fire if still breached)
  private readonly ALERT_STATE_CACHE_MAX_SIZE = 1000;

  // 24 hour TTL: Balances memory usage vs. preventing re-fire after long quiet periods
  // After 24h, an alert can re-fire even if never recovered (acceptable for persistent issues)
  private readonly ALERT_STATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // Response body size limits
  // 10KB limit: Balances debug utility vs. database storage costs
  // Large HTML error pages (500 errors) often exceed this, but we capture enough for debugging
  // For full responses, consider object storage integration (S3, etc.)
  private readonly MAX_STORED_RESPONSE_BODY_BYTES = 10_000;

  // Test webhook response preview limit (1KB)
  // Smaller than delivery limit since test responses are returned synchronously to API caller
  private readonly MAX_TEST_RESPONSE_PREVIEW_BYTES = 1_000;

  // Track alert states with LRU cache to prevent memory leak
  private alertStates = new LRUCache<string, AlertState>({
    max: this.ALERT_STATE_CACHE_MAX_SIZE,
    ttl: this.ALERT_STATE_CACHE_TTL_MS,
  });

  // Instance context
  private readonly sourceHost: string;
  private readonly sourcePort: number;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly webhooksService: WebhooksService,
    private readonly configService: ConfigService,
  ) {
    this.REQUEST_TIMEOUT_MS = this.configService.get<number>('WEBHOOK_TIMEOUT_MS', 30000);
    this.sourceHost = this.configService.get<string>('database.host', 'localhost');
    this.sourcePort = this.configService.get<number>('database.port', 6379);
  }

  /**
   * Dispatch a webhook event to all subscribed webhooks
   */
  async dispatchEvent(
    eventType: WebhookEventType,
    data: Record<string, any>,
  ): Promise<void> {
    try {
      const webhooks = await this.webhooksService.getWebhooksByEvent(eventType);

      if (webhooks.length === 0) {
        this.logger.debug(`No webhooks subscribed to event: ${eventType}`);
        return;
      }

      this.logger.log(`Dispatching ${eventType} to ${webhooks.length} webhook(s)`);

      // Dispatch to all webhooks in parallel
      await Promise.allSettled(
        webhooks.map(webhook => this.dispatchToWebhook(webhook, eventType, data))
      );

    } catch (error) {
      this.logger.error(`Failed to dispatch event ${eventType}:`, error);
    }
  }

  /**
   * Check if alert should fire (with hysteresis to prevent flapping)
   */
  private shouldFireAlert(
    alertKey: string,
    currentValue: number,
    threshold: number,
    isAbove: boolean,
  ): boolean {
    const state = this.alertStates.get(alertKey);
    const conditionMet = isAbove ? currentValue >= threshold : currentValue <= threshold;

    if (!state) {
      // No previous state - fire if condition is met
      if (conditionMet) {
        this.alertStates.set(alertKey, {
          fired: true,
          firedAt: Date.now(),
          value: currentValue,
        });
        return true;
      }
      return false;
    }

    // Already fired - check for recovery (configurable hysteresis)
    const recoveryThreshold = isAbove
      ? threshold * this.ALERT_HYSTERESIS_FACTOR
      : threshold * (2 - this.ALERT_HYSTERESIS_FACTOR); // Mirror for below-threshold alerts
    const recovered = isAbove ? currentValue < recoveryThreshold : currentValue > recoveryThreshold;

    if (recovered) {
      this.alertStates.delete(alertKey);
      this.logger.debug(`Alert ${alertKey} recovered: ${currentValue} (threshold: ${threshold})`);
    }

    return false;
  }

  /**
   * Dispatch threshold-based alert (e.g., memory.critical, connection.critical)
   */
  async dispatchThresholdAlert(
    eventType: WebhookEventType,
    alertKey: string,
    currentValue: number,
    threshold: number,
    isAbove: boolean,
    data: Record<string, any>,
  ): Promise<void> {
    if (this.shouldFireAlert(alertKey, currentValue, threshold, isAbove)) {
      this.logger.log(
        `Threshold alert triggered: ${eventType} (${currentValue} ${isAbove ? '>=' : '<='} ${threshold})`
      );
      await this.dispatchEvent(eventType, data);
    }
  }

  /**
   * Dispatch health change events (instance.down, instance.up)
   */
  async dispatchHealthChange(
    eventType: WebhookEventType.INSTANCE_DOWN | WebhookEventType.INSTANCE_UP,
    data: Record<string, any>,
  ): Promise<void> {
    await this.dispatchEvent(eventType, data);
  }

  /**
   * Sanitize custom headers to prevent header injection
   */
  private sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers || {})) {
      const lowerKey = key.toLowerCase();
      if (!this.BLOCKED_HEADERS.includes(lowerKey)) {
        sanitized[key] = value;
      } else {
        this.logger.warn(`Blocked restricted header in webhook: ${key}`);
      }
    }
    return sanitized;
  }

  /**
   * Generate signature with timestamp for replay attack protection
   */
  generateSignatureWithTimestamp(payload: string, secret: string, timestamp: number): string {
    const signedContent = `${timestamp}.${payload}`;
    return this.webhooksService.generateSignature(signedContent, secret);
  }

  /**
   * Dispatch event to a single webhook
   */
  private async dispatchToWebhook(
    webhook: Webhook,
    eventType: WebhookEventType,
    data: Record<string, any>,
  ): Promise<void> {
    // Skip if webhook is disabled
    if (!webhook.enabled) {
      this.logger.debug(`Skipping disabled webhook: ${webhook.id}`);
      return;
    }

    const payload: WebhookPayload = {
      id: crypto.randomUUID(),
      event: eventType,
      timestamp: Date.now(),
      instance: {
        host: this.sourceHost,
        port: this.sourcePort,
      },
      data,
    };

    // Create delivery record
    const delivery = await this.storageClient.createDelivery({
      webhookId: webhook.id,
      eventType,
      payload,
      status: DeliveryStatus.PENDING,
      attempts: 0,
    });

    // Send webhook immediately
    await this.sendWebhook(webhook, delivery.id, payload);
  }

  /**
   * Send webhook HTTP request
   */
  async sendWebhook(
    webhook: Webhook,
    deliveryId: string,
    payload: WebhookPayload,
  ): Promise<void> {
    const startTime = Date.now();
    let status: DeliveryStatus = DeliveryStatus.PENDING;
    let statusCode: number | undefined;
    let responseBody: string | undefined;

    try {
      // Prepare request
      const payloadString = JSON.stringify(payload);
      const timestamp = payload.timestamp;
      const signature = this.generateSignatureWithTimestamp(payloadString, webhook.secret || '', timestamp);

      // Sanitize custom headers
      const sanitizedCustomHeaders = this.sanitizeHeaders(webhook.headers || {});

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'BetterDB-Monitor/1.0',
        'X-Webhook-Signature': signature,
        'X-Webhook-Timestamp': timestamp.toString(),
        'X-Webhook-Id': webhook.id,
        'X-Webhook-Delivery-Id': deliveryId,
        'X-Webhook-Event': payload.event,
        ...sanitizedCustomHeaders,
      };

      // Send request with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(webhook.url, {
          method: 'POST',
          headers,
          body: payloadString,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        statusCode = response.status;
        responseBody = await response.text().catch(() => '');

        // Consider 2xx as success
        if (response.ok) {
          status = DeliveryStatus.SUCCESS;
          this.logger.log(`Webhook delivered successfully: ${webhook.id} -> ${webhook.url}`);
        } else if (statusCode >= 400 && statusCode < 500) {
          // 4xx errors are client errors - don't retry
          status = DeliveryStatus.FAILED;
          this.logger.warn(
            `Webhook delivery failed with client error ${statusCode}: ${webhook.id} -> ${webhook.url}`
          );
        } else {
          // 5xx errors are server errors - retry
          status = DeliveryStatus.RETRYING;
          this.logger.warn(
            `Webhook delivery failed with server error ${statusCode}: ${webhook.id} -> ${webhook.url}`
          );
        }

      } catch (fetchError: any) {
        clearTimeout(timeoutId);

        // Handle specific errors
        if (fetchError.name === 'AbortError') {
          status = DeliveryStatus.RETRYING;
          responseBody = 'Request timeout';
          this.logger.warn(`Webhook delivery timeout: ${webhook.id} -> ${webhook.url}`);
        } else {
          status = DeliveryStatus.RETRYING;
          responseBody = fetchError.message || 'Network error';
          this.logger.error(`Webhook delivery error: ${webhook.id} -> ${webhook.url}`, fetchError);
        }
      }

    } catch (error: any) {
      status = DeliveryStatus.FAILED;
      responseBody = error.message || 'Unknown error';
      this.logger.error(`Failed to send webhook ${webhook.id}:`, error);
    }

    const durationMs = Date.now() - startTime;

    // Update delivery record
    await this.updateDelivery(deliveryId, webhook, status, {
      statusCode,
      responseBody: responseBody?.substring(0, this.MAX_STORED_RESPONSE_BODY_BYTES),
      durationMs,
    });
  }

  /**
   * Update delivery record after attempt
   */
  private async updateDelivery(
    deliveryId: string,
    webhook: Webhook,
    status: DeliveryStatus,
    details: {
      statusCode?: number;
      responseBody?: string;
      durationMs: number;
    },
  ): Promise<void> {
    try {
      const delivery = await this.storageClient.getDelivery(deliveryId);
      if (!delivery) {
        this.logger.error(`Delivery not found: ${deliveryId}`);
        return;
      }

      const attempts = delivery.attempts + 1;
      const updates: any = {
        attempts,
        status,
        statusCode: details.statusCode,
        responseBody: details.responseBody,
        durationMs: details.durationMs,
      };

      // If successful, mark as completed
      if (status === DeliveryStatus.SUCCESS) {
        updates.completedAt = Date.now();
      }

      // If retrying, calculate next retry time
      if (status === DeliveryStatus.RETRYING && attempts < webhook.retryPolicy.maxRetries) {
        const delay = Math.min(
          webhook.retryPolicy.initialDelayMs * Math.pow(webhook.retryPolicy.backoffMultiplier, attempts - 1),
          webhook.retryPolicy.maxDelayMs
        );
        updates.nextRetryAt = Date.now() + delay;
      } else if (status === DeliveryStatus.RETRYING) {
        // Max retries reached - mark as dead letter for manual investigation
        updates.status = DeliveryStatus.DEAD_LETTER;
        updates.completedAt = Date.now();
        this.logger.warn(`Delivery ${deliveryId} moved to dead letter queue after ${attempts} attempts`);
      }

      await this.storageClient.updateDelivery(deliveryId, updates);

    } catch (error) {
      this.logger.error(`Failed to update delivery ${deliveryId}:`, error);
    }
  }

  /**
   * Test a webhook by sending a test event
   */
  async testWebhook(webhook: Webhook): Promise<{
    success: boolean;
    statusCode?: number;
    responseBody?: string;
    error?: string;
    durationMs: number;
  }> {
    const startTime = Date.now();

    try {
      // Use first subscribed event for testing, or instance.down as fallback
      const testEventType = webhook.events.length > 0 ? webhook.events[0] : ('instance.down' as WebhookEventType);

      const testPayload: WebhookPayload = {
        id: crypto.randomUUID(),
        event: testEventType,
        timestamp: Date.now(),
        instance: {
          host: this.sourceHost,
          port: this.sourcePort,
        },
        data: {
          test: true,
          message: 'This is a test webhook from BetterDB Monitor',
        },
      };

      const payloadString = JSON.stringify(testPayload);
      const timestamp = testPayload.timestamp;
      const signature = this.generateSignatureWithTimestamp(payloadString, webhook.secret || '', timestamp);

      // Sanitize custom headers
      const sanitizedCustomHeaders = this.sanitizeHeaders(webhook.headers || {});

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'BetterDB-Monitor/1.0',
        'X-Webhook-Signature': signature,
        'X-Webhook-Timestamp': timestamp.toString(),
        'X-Webhook-Id': webhook.id,
        'X-Webhook-Event': testPayload.event,
        'X-Webhook-Test': 'true',
        ...sanitizedCustomHeaders,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body: payloadString,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseBody = await response.text().catch(() => '');
      const durationMs = Date.now() - startTime;

      return {
        success: response.ok,
        statusCode: response.status,
        responseBody: responseBody.substring(0, this.MAX_TEST_RESPONSE_PREVIEW_BYTES),
        durationMs,
      };

    } catch (error: any) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        error: error.message || 'Unknown error',
        durationMs,
      };
    }
  }
}
