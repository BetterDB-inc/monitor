import { Injectable, Inject, Logger } from '@nestjs/common';
import type { Webhook, WebhookPayload, WebhookEventType } from '@betterdb/shared';
import { DeliveryStatus } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhooksService } from './webhooks.service';

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly REQUEST_TIMEOUT_MS = 30000; // 30 seconds

  // Track alert states to avoid repeated firing (with hysteresis)
  private alertStates = new Map<string, {
    fired: boolean;
    firedAt: number;
    value: number;
  }>();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly webhooksService: WebhooksService,
  ) {}

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

    // Already fired - check for recovery (10% hysteresis)
    const recoveryThreshold = isAbove ? threshold * 0.9 : threshold * 1.1;
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
      const signature = this.webhooksService.generateSignature(payloadString, webhook.secret || '');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'BetterDB-Monitor/1.0',
        'X-Webhook-Signature': signature,
        'X-Webhook-Id': webhook.id,
        'X-Webhook-Delivery-Id': deliveryId,
        'X-Webhook-Event': payload.event,
        ...webhook.headers,
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
        } else {
          status = DeliveryStatus.RETRYING;
          this.logger.warn(
            `Webhook delivery failed with status ${statusCode}: ${webhook.id} -> ${webhook.url}`
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
      responseBody: responseBody?.substring(0, 10000), // Limit response body size
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
        // Max retries reached
        updates.status = DeliveryStatus.FAILED;
        updates.completedAt = Date.now();
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
      const testPayload: WebhookPayload = {
        id: crypto.randomUUID(),
        event: 'instance.down' as WebhookEventType, // Use a valid event type for testing
        timestamp: Date.now(),
        data: {
          test: true,
          message: 'This is a test webhook from BetterDB Monitor',
        },
      };

      const payloadString = JSON.stringify(testPayload);
      const signature = this.webhooksService.generateSignature(payloadString, webhook.secret || '');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'BetterDB-Monitor/1.0',
        'X-Webhook-Signature': signature,
        'X-Webhook-Id': webhook.id,
        'X-Webhook-Event': testPayload.event,
        'X-Webhook-Test': 'true',
        ...webhook.headers,
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
        responseBody: responseBody.substring(0, 1000), // Limit response
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
