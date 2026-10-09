import { Injectable, Inject, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LRUCache } from 'lru-cache';
import type {
  Webhook,
  WebhookDelivery,
  WebhookPayload,
  WebhookEventType,
  WebhookThresholds,
} from '@betterdb/shared';
import { WebhookPayloadFormat } from '@betterdb/shared';
import {
  DeliveryStatus,
  getDeliveryConfig,
  getAlertConfig,
  getThreshold,
  DEFAULT_DELIVERY_CONFIG,
  DEFAULT_ALERT_CONFIG,
} from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhooksService } from './webhooks.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { formatWebhookBody } from './webhook-payload-formatter';

interface AlertState {
  fired: boolean;
  firedAt: number;
  value: number;
}

interface PendingEvent {
  sequence: number;
  eventType: WebhookEventType;
  data: Record<string, unknown>;
  connectionId?: string;
  timestamp: number;
  payloads: Map<string, WebhookPayload>;
  pendingWebhookIds: Set<string> | null;
  unconfirmedWebhookIds: Set<string>;
}

const STORAGE_UNAVAILABLE = 'storage-unavailable' as const;

@Injectable()
export class WebhookDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly STORAGE_RETRY_BUFFER_MAX_EVENTS = 1000;
  private readonly STORAGE_RETRY_INITIAL_DELAY_MS = 1_000;
  private readonly STORAGE_RETRY_MAX_DELAY_MS = 60_000;
  private readonly UNCONFIRMED_DELIVERY_LOOKBACK = 100;
  private storageRetryBuffer: PendingEvent[] = [];
  private inFlightEvent: PendingEvent | null = null;
  private readonly inFlightDirectDispatches = new Set<Promise<boolean>>();
  private nextEventSequence = 0;
  private flushing = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private consecutiveFlushFailures = 0;
  private droppedEventCount = 0;
  private destroyed = false;
  private readonly DEFAULT_REQUEST_TIMEOUT_MS: number;
  private readonly BLOCKED_HEADERS = [
    'host',
    'content-length',
    'transfer-encoding',
    'connection',
    'upgrade',
  ];

  // Alert hysteresis configuration (default, can be overridden per-webhook)
  // 10% hysteresis prevents alert flapping - e.g., for 90% threshold:
  // - Alert fires at 90%
  // - Alert clears only when drops below 81% (90% * 0.9)
  // - This prevents oscillation around the threshold boundary
  private readonly DEFAULT_ALERT_HYSTERESIS_FACTOR = DEFAULT_ALERT_CONFIG.hysteresisFactor;

  // Alert state cache configuration
  // Max 1000 alerts: Sufficient for typical deployments (even 100 instances × 10 metrics = 1000)
  // Exceeding 1000 means LRU evicts oldest, which is acceptable (they'll re-fire if still breached)
  private readonly ALERT_STATE_CACHE_MAX_SIZE = 1000;

  // 24 hour TTL: Balances memory usage vs. preventing re-fire after long quiet periods
  // After 24h, an alert can re-fire even if never recovered (acceptable for persistent issues)
  private readonly ALERT_STATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  // Response body size limits (defaults, can be overridden per-webhook)
  // 10KB limit: Balances debug utility vs. database storage costs
  // Large HTML error pages (500 errors) often exceed this, but we capture enough for debugging
  // For full responses, consider object storage integration (S3, etc.)
  private readonly DEFAULT_MAX_STORED_RESPONSE_BODY_BYTES =
    DEFAULT_DELIVERY_CONFIG.maxResponseBodyBytes;

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
  private readonly appBaseUrl?: string;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly webhooksService: WebhooksService,
    private readonly configService: ConfigService,
    @Optional() private readonly connectionRegistry?: ConnectionRegistry,
  ) {
    this.DEFAULT_REQUEST_TIMEOUT_MS = this.configService.get<number>(
      'WEBHOOK_TIMEOUT_MS',
      DEFAULT_DELIVERY_CONFIG.timeoutMs,
    );
    this.sourceHost = this.configService.get<string>('database.host', 'localhost');
    this.sourcePort = this.configService.get<number>('database.port', 6379);
    this.appBaseUrl = this.configService.get<string>('FRONTEND_URL');
  }

  /**
   * Get host/port for a connection, falling back to default config values
   */
  private getInstanceInfo(connectionId?: string): { host: string; port: number } {
    if (connectionId && this.connectionRegistry) {
      const config = this.connectionRegistry.getConfig(connectionId);
      if (config) {
        return { host: config.host, port: config.port };
      }
    }
    return { host: this.sourceHost, port: this.sourcePort };
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.storageRetryBuffer.length > 0) {
      this.logger.warn(
        `Discarding ${this.storageRetryBuffer.length} webhook event(s) buffered after storage failures on shutdown`,
      );
      this.storageRetryBuffer = [];
    }
  }

  getStorageRetryBufferStats(): { bufferedEvents: number; droppedEvents: number } {
    return {
      bufferedEvents: this.storageRetryBuffer.length,
      droppedEvents: this.droppedEventCount,
    };
  }

  /**
   * Dispatch a webhook event to all subscribed webhooks
   * @returns true when the event was accepted: every delivery succeeded, was
   * skipped, is owned by the retry processor (RETRYING), or is held in the
   * in-memory storage retry buffer because storage failed before its
   * delivery row was written. false only for terminal failures nothing else
   * will retry. Never throws for delivery failures.
   */
  async dispatchEvent(
    eventType: WebhookEventType,
    data: Record<string, unknown>,
    connectionId?: string,
  ): Promise<boolean> {
    const enrichedData = connectionId ? { ...data, connectionId } : data;
    return this.dispatchPendingEvent(this.createPendingEvent(eventType, enrichedData, connectionId));
  }

  private createPendingEvent(
    eventType: WebhookEventType,
    data: Record<string, unknown>,
    connectionId?: string,
    targetWebhookIds?: string[],
  ): PendingEvent {
    return {
      sequence: this.nextEventSequence++,
      eventType,
      data,
      connectionId,
      timestamp: Date.now(),
      payloads: new Map(),
      pendingWebhookIds: targetWebhookIds ? new Set(targetWebhookIds) : null,
      unconfirmedWebhookIds: new Set(),
    };
  }

  private async dispatchPendingEvent(
    event: PendingEvent,
    webhooks?: Webhook[],
  ): Promise<boolean> {
    if (this.storageRetryBuffer.length > 0) {
      return this.bufferEvent(event);
    }

    const dispatch = this.deliverDirectly(event, webhooks);
    this.inFlightDirectDispatches.add(dispatch);
    try {
      return await dispatch;
    } finally {
      this.inFlightDirectDispatches.delete(dispatch);
    }
  }

  private async deliverDirectly(event: PendingEvent, webhooks?: Webhook[]): Promise<boolean> {
    const outcome = await this.deliverEvent(event, webhooks);
    if (outcome.storageUnavailable && !this.bufferEvent(event)) {
      return false;
    }
    return !outcome.terminalFailure;
  }

  private async deliverEvent(
    event: PendingEvent,
    knownWebhooks?: Webhook[],
  ): Promise<{ storageUnavailable: boolean; terminalFailure: boolean }> {
    const { eventType, connectionId } = event;
    let webhooks: Webhook[];
    if (knownWebhooks) {
      webhooks = knownWebhooks;
    } else {
      try {
        webhooks = await this.webhooksService.getWebhooksByEvent(eventType, connectionId);
      } catch (error) {
        this.logger.error(`Failed to look up webhooks for event ${eventType}:`, error);
        return { storageUnavailable: true, terminalFailure: false };
      }
    }

    const pending = event.pendingWebhookIds;
    const targets = pending ? webhooks.filter((webhook) => pending.has(webhook.id)) : webhooks;
    event.pendingWebhookIds = new Set(targets.map((webhook) => webhook.id));

    if (targets.length === 0) {
      this.logger.debug(
        `No webhooks subscribed to event: ${eventType}${connectionId ? ` for connection ${connectionId}` : ''}`,
      );
      return { storageUnavailable: false, terminalFailure: false };
    }

    this.logger.log(
      `Dispatching ${eventType} to ${targets.length} webhook(s)${connectionId ? ` for connection ${connectionId}` : ''}`,
    );

    const settled = await Promise.allSettled(
      targets.map((webhook) => this.dispatchToWebhook(webhook, event)),
    );

    const storageUnavailable = settled.some(
      (result) => result.status === 'fulfilled' && result.value === STORAGE_UNAVAILABLE,
    );
    const failed = settled.filter((result) => {
      if (result.status === 'rejected') {
        return true;
      }
      return (
        result.value === DeliveryStatus.FAILED || result.value === DeliveryStatus.DEAD_LETTER
      );
    });

    if (failed.length > 0) {
      this.logger.warn(
        `Webhook dispatch for ${eventType} had ${failed.length}/${settled.length} failed deliveries`,
      );
    }

    return { storageUnavailable, terminalFailure: failed.length > 0 };
  }

  private bufferEvent(event: PendingEvent): boolean {
    if (this.destroyed) {
      this.logger.error(
        `Dropping ${event.eventType} event: storage unavailable and the dispatcher is shutting down`,
      );
      return false;
    }

    if (this.storageRetryBuffer.length >= this.STORAGE_RETRY_BUFFER_MAX_EVENTS) {
      const dropIndex = this.storageRetryBuffer[0] === this.inFlightEvent ? 1 : 0;
      const [dropped] = this.storageRetryBuffer.splice(dropIndex, 1);
      this.droppedEventCount++;
      this.logger.error(
        `Webhook storage retry buffer full (${this.STORAGE_RETRY_BUFFER_MAX_EVENTS} events); dropped ${dropped.eventType} event from ${new Date(dropped.timestamp).toISOString()} (${this.droppedEventCount} dropped since start)`,
      );
    }

    let insertAt = this.storageRetryBuffer.length;
    while (insertAt > 0 && this.storageRetryBuffer[insertAt - 1].sequence > event.sequence) {
      insertAt--;
    }
    this.storageRetryBuffer.splice(insertAt, 0, event);
    this.logger.warn(
      `Buffered ${event.eventType} event for retry after a storage failure (${this.storageRetryBuffer.length} buffered)`,
    );
    this.scheduleFlush();
    return true;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.destroyed) {
      return;
    }
    const delay = Math.min(
      this.STORAGE_RETRY_INITIAL_DELAY_MS * Math.pow(2, this.consecutiveFlushFailures),
      this.STORAGE_RETRY_MAX_DELAY_MS,
    );
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushStorageRetryBuffer();
    }, delay);
  }

  private async flushStorageRetryBuffer(): Promise<void> {
    if (this.flushing || this.destroyed) {
      return;
    }
    this.flushing = true;
    try {
      await Promise.allSettled([...this.inFlightDirectDispatches]);
      await this.drainStorageRetryBuffer();
    } finally {
      this.flushing = false;
    }
  }

  private async drainStorageRetryBuffer(): Promise<void> {
    let flushed = 0;
    while (this.storageRetryBuffer.length > 0 && !this.destroyed) {
      const event = this.storageRetryBuffer[0];
      this.inFlightEvent = event;
      let storageUnavailable: boolean;
      try {
        storageUnavailable = (await this.deliverEvent(event)).storageUnavailable;
      } finally {
        this.inFlightEvent = null;
      }

      if (storageUnavailable) {
        this.consecutiveFlushFailures++;
        this.scheduleFlush();
        return;
      }

      const index = this.storageRetryBuffer.indexOf(event);
      if (index !== -1) {
        this.storageRetryBuffer.splice(index, 1);
      }
      flushed++;
    }

    this.consecutiveFlushFailures = 0;
    if (flushed > 0) {
      this.logger.log(`Storage recovered; dispatched ${flushed} buffered webhook event(s)`);
    }
  }

  /**
   * Check if alert should fire (with hysteresis to prevent flapping)
   */
  shouldFireAlert(
    alertKey: string,
    currentValue: number,
    threshold: number,
    isAbove: boolean,
    hysteresisFactor: number = this.DEFAULT_ALERT_HYSTERESIS_FACTOR,
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
      ? threshold * hysteresisFactor
      : threshold * (2 - hysteresisFactor); // Mirror for below-threshold alerts
    const recovered = isAbove ? currentValue < recoveryThreshold : currentValue > recoveryThreshold;

    if (recovered) {
      this.alertStates.delete(alertKey);
      this.logger.debug(`Alert ${alertKey} recovered: ${currentValue} (threshold: ${threshold})`);
    }

    return false;
  }

  /**
   * Dispatch threshold-based alert (e.g., memory.critical, connection.critical)
   * Uses global threshold - consider using dispatchThresholdAlertPerWebhook for per-webhook thresholds
   * Returns whether the alert edge actually fired (hysteresis suppresses repeats).
   */
  async dispatchThresholdAlert(
    eventType: WebhookEventType,
    alertKey: string,
    currentValue: number,
    threshold: number,
    isAbove: boolean,
    data: Record<string, unknown>,
    connectionId?: string,
  ): Promise<boolean> {
    if (!this.shouldFireAlert(alertKey, currentValue, threshold, isAbove)) {
      return false;
    }

    this.logger.log(
      `Threshold alert triggered: ${eventType} (${currentValue} ${isAbove ? '>=' : '<='} ${threshold})`,
    );
    await this.dispatchEvent(eventType, data, connectionId);
    return true;
  }

  /**
   * Dispatch threshold-based alert with per-webhook threshold configuration
   * Each webhook can have its own threshold for the same alert type
   * @param eventType The event type to dispatch
   * @param alertKeyPrefix Prefix for alert state tracking
   * @param currentValue The current metric value
   * @param thresholdKey The threshold key to use
   * @param isAbove True if alert fires when value is above threshold
   * @param data Event data payload
   * @param connectionId Optional connection ID to filter webhooks and include in payload
   */
  async dispatchThresholdAlertPerWebhook(
    eventType: WebhookEventType,
    alertKeyPrefix: string,
    currentValue: number,
    thresholdKey: keyof WebhookThresholds,
    isAbove: boolean,
    data: Record<string, unknown> | ((threshold: number) => Record<string, unknown>),
    connectionId?: string,
  ): Promise<boolean> {
    let firedAny = false;
    try {
      // Get webhooks subscribed to this event, filtered by connectionId
      const webhooks = await this.webhooksService.getWebhooksByEvent(eventType, connectionId);

      if (webhooks.length === 0) {
        this.logger.debug(
          `No webhooks subscribed to event: ${eventType}${connectionId ? ` for connection ${connectionId}` : ''}`,
        );
        return false;
      }

      // Dispatch to each webhook with its own threshold
      await Promise.allSettled(
        webhooks.map(async (webhook) => {
          // Get per-webhook threshold and alert config
          const threshold = getThreshold(webhook, thresholdKey);
          const alertConfig = getAlertConfig(webhook);

          // Use per-webhook alert key to track state independently
          // Include connectionId in alert key for per-connection tracking
          const alertKey = connectionId
            ? `${alertKeyPrefix}:${connectionId}:${webhook.id}`
            : `${alertKeyPrefix}:${webhook.id}`;

          if (
            this.shouldFireAlert(
              alertKey,
              currentValue,
              threshold,
              isAbove,
              alertConfig.hysteresisFactor,
            )
          ) {
            this.logger.log(
              `Threshold alert triggered for webhook ${webhook.id}: ${eventType} (${currentValue} ${isAbove ? '>=' : '<='} ${threshold})`,
            );

            firedAny = true;
            // Add threshold info to data
            const base = typeof data === 'function' ? data(threshold) : data;
            const enrichedData = {
              ...base,
              threshold,
              thresholdKey,
              ...(connectionId && { connectionId }),
            };

            await this.dispatchPendingEvent(
              this.createPendingEvent(eventType, enrichedData, connectionId, [webhook.id]),
              [webhook],
            );
          }
        }),
      );
    } catch (error) {
      this.logger.error(`Failed to dispatch per-webhook threshold alert ${eventType}:`, error);
    }
    return firedAny;
  }

  /**
   * Dispatch health change events (instance.down, instance.up)
   * @param eventType The health event type
   * @param data Event data payload
   * @param connectionId Optional connection ID to include in payload
   */
  async dispatchHealthChange(
    eventType: WebhookEventType.INSTANCE_DOWN | WebhookEventType.INSTANCE_UP,
    data: Record<string, unknown>,
    connectionId?: string,
  ): Promise<void> {
    await this.dispatchEvent(eventType, data, connectionId);
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
   * @returns The delivery status, null when skipped (disabled or already
   * handled), or STORAGE_UNAVAILABLE when the delivery row could not be written.
   */
  private async dispatchToWebhook(
    webhook: Webhook,
    event: PendingEvent,
  ): Promise<DeliveryStatus | null | typeof STORAGE_UNAVAILABLE> {
    // Skip if webhook is disabled
    if (!webhook.enabled) {
      this.logger.debug(`Skipping disabled webhook: ${webhook.id}`);
      event.pendingWebhookIds?.delete(webhook.id);
      return null;
    }

    const payload = this.getOrCreatePayload(webhook.id, event);

    let deliveryId: string | null;
    try {
      deliveryId = await this.persistDelivery(webhook.id, event, payload);
    } catch (error) {
      event.unconfirmedWebhookIds.add(webhook.id);
      this.logger.error(
        `Failed to create delivery for webhook ${webhook.id} (${event.eventType}):`,
        error,
      );
      return STORAGE_UNAVAILABLE;
    }

    event.pendingWebhookIds?.delete(webhook.id);
    if (deliveryId === null) {
      return null;
    }
    return this.sendWebhook(webhook, deliveryId, payload);
  }

  private getOrCreatePayload(webhookId: string, event: PendingEvent): WebhookPayload {
    const existing = event.payloads.get(webhookId);
    if (existing) {
      return existing;
    }
    const instanceInfo = this.getInstanceInfo(event.connectionId);
    const payload: WebhookPayload = {
      id: crypto.randomUUID(),
      event: event.eventType,
      timestamp: event.timestamp,
      instance: {
        host: instanceInfo.host,
        port: instanceInfo.port,
        connectionId: event.connectionId,
      },
      data: event.data,
    };
    event.payloads.set(webhookId, payload);
    return payload;
  }

  private async persistDelivery(
    webhookId: string,
    event: PendingEvent,
    payload: WebhookPayload,
  ): Promise<string | null> {
    if (event.unconfirmedWebhookIds.has(webhookId)) {
      const recent = await this.storageClient.getDeliveriesByWebhook(
        webhookId,
        this.UNCONFIRMED_DELIVERY_LOOKBACK,
      );
      const written = recent.find((delivery) => delivery.payload?.id === payload.id);
      if (written) {
        event.unconfirmedWebhookIds.delete(webhookId);
        return written.status === DeliveryStatus.PENDING && written.attempts === 0
          ? written.id
          : null;
      }
    }

    // Create delivery record with connectionId for scoping
    const delivery = await this.storageClient.createDelivery({
      webhookId,
      eventType: event.eventType,
      payload,
      status: DeliveryStatus.PENDING,
      attempts: 0,
      connectionId: event.connectionId,
    });
    event.unconfirmedWebhookIds.delete(webhookId);
    return delivery.id;
  }

  /**
   * Send webhook HTTP request
   * @returns The status for this attempt (SUCCESS only on 2xx).
   */
  async sendWebhook(
    webhook: Webhook,
    deliveryId: string,
    payload: WebhookPayload,
  ): Promise<DeliveryStatus> {
    const startTime = Date.now();
    let status: DeliveryStatus;
    let statusCode: number | undefined;
    let responseBody: string | undefined;

    // Get per-webhook delivery config
    const deliveryConfig = getDeliveryConfig(webhook);
    const timeoutMs = deliveryConfig.timeoutMs;
    const maxResponseBodyBytes = deliveryConfig.maxResponseBodyBytes;

    try {
      // Prepare request (body rendered per webhook.payloadFormat)
      const payloadString = formatWebhookBody(webhook, payload, this.appBaseUrl);
      const timestamp = payload.timestamp;
      const signature = this.generateSignatureWithTimestamp(
        payloadString,
        webhook.secret || '',
        timestamp,
      );

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
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
            `Webhook delivery failed with client error ${statusCode}: ${webhook.id} -> ${webhook.url}`,
          );
        } else {
          // 5xx errors are server errors - retry
          status = DeliveryStatus.RETRYING;
          this.logger.warn(
            `Webhook delivery failed with server error ${statusCode}: ${webhook.id} -> ${webhook.url}`,
          );
        }
      } catch (fetchError) {
        clearTimeout(timeoutId);

        // Handle specific errors
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          status = DeliveryStatus.RETRYING;
          responseBody = 'Request timeout';
          this.logger.warn(`Webhook delivery timeout: ${webhook.id} -> ${webhook.url}`);
        } else {
          status = DeliveryStatus.RETRYING;
          responseBody =
            fetchError instanceof Error && fetchError.message
              ? fetchError.message
              : 'Network error';
          this.logger.error(`Webhook delivery error: ${webhook.id} -> ${webhook.url}`, fetchError);
        }
      }
    } catch (error) {
      status = DeliveryStatus.FAILED;
      responseBody = error instanceof Error && error.message ? error.message : 'Unknown error';
      this.logger.error(`Failed to send webhook ${webhook.id}:`, error);
    }

    const durationMs = Date.now() - startTime;

    // Update delivery record
    await this.updateDelivery(deliveryId, webhook, status, {
      statusCode,
      responseBody: responseBody?.substring(0, maxResponseBodyBytes),
      durationMs,
    });

    return status;
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
      const updates: Partial<Omit<WebhookDelivery, 'id' | 'webhookId' | 'createdAt'>> = {
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
          webhook.retryPolicy.initialDelayMs *
            Math.pow(webhook.retryPolicy.backoffMultiplier, attempts - 1),
          webhook.retryPolicy.maxDelayMs,
        );
        updates.nextRetryAt = Date.now() + delay;
      } else if (status === DeliveryStatus.RETRYING) {
        // Max retries reached - mark as dead letter for manual investigation
        updates.status = DeliveryStatus.DEAD_LETTER;
        updates.completedAt = Date.now();
        this.logger.warn(
          `Delivery ${deliveryId} moved to dead letter queue after ${attempts} attempts`,
        );
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
    payloadFormat?: WebhookPayloadFormat;
    renderedPayload?: Record<string, unknown>;
  }> {
    const startTime = Date.now();

    // Get per-webhook delivery config
    const deliveryConfig = getDeliveryConfig(webhook);
    const timeoutMs = deliveryConfig.timeoutMs;

    let renderedPayload: Record<string, unknown> | undefined;

    try {
      // Use first subscribed event for testing, or instance.down as fallback
      const testEventType =
        webhook.events.length > 0 ? webhook.events[0] : ('instance.down' as WebhookEventType);

      // Get instance info for the webhook's connection (consistent with real dispatches)
      const instanceInfo = this.getInstanceInfo(webhook.connectionId);

      const testPayload: WebhookPayload = {
        id: crypto.randomUUID(),
        event: testEventType,
        timestamp: Date.now(),
        instance: {
          host: instanceInfo.host,
          port: instanceInfo.port,
          connectionId: webhook.connectionId,
        },
        data: {
          test: true,
          message: 'This is a test webhook from BetterDB Monitor',
        },
      };

      const payloadString = formatWebhookBody(webhook, testPayload, this.appBaseUrl);
      renderedPayload = JSON.parse(payloadString) as Record<string, unknown>;
      const timestamp = testPayload.timestamp;
      const signature = this.generateSignatureWithTimestamp(
        payloadString,
        webhook.secret || '',
        timestamp,
      );

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
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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
        payloadFormat: webhook.payloadFormat ?? WebhookPayloadFormat.GENERIC,
        renderedPayload,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      return {
        success: false,
        error: error instanceof Error && error.message ? error.message : 'Unknown error',
        durationMs,
        payloadFormat: webhook.payloadFormat ?? WebhookPayloadFormat.GENERIC,
        renderedPayload,
      };
    }
  }
}
