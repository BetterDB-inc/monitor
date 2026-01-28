import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import type { WebhookEventType } from '@betterdb/shared';

/**
 * Webhook Pro Service - Handles advanced webhook features for Pro+ tiers
 *
 * Features:
 * - Operational event webhooks (Pro+)
 * - Advanced retry configuration (Pro+)
 * - Integration with anomaly detection
 */
@Injectable()
export class WebhookProService implements OnModuleInit {
  private readonly logger = new Logger(WebhookProService.name);

  constructor(
    private readonly dispatcherService: WebhookDispatcherService,
  ) {}

  async onModuleInit() {
    this.logger.log('Webhook Pro service initialized');
  }

  /**
   * Dispatch anomaly detected event
   */
  async dispatchAnomalyDetected(data: {
    anomalyId: string;
    metricType: string;
    severity: string;
    value: number;
    baseline: number;
    threshold: number;
    message: string;
    timestamp: number;
  }): Promise<void> {
    await this.dispatcherService.dispatchEvent('anomaly.detected' as WebhookEventType, data);
  }

  /**
   * Dispatch slowlog threshold event
   */
  async dispatchSlowlogThreshold(data: {
    slowlogCount: number;
    threshold: number;
    timestamp: number;
  }): Promise<void> {
    await this.dispatcherService.dispatchEvent('slowlog.threshold' as WebhookEventType, data);
  }

  /**
   * Dispatch latency spike event
   */
  async dispatchLatencySpike(data: {
    currentLatency: number;
    baseline: number;
    threshold: number;
    timestamp: number;
    instance: { host: string; port: number };
  }): Promise<void> {
    await this.dispatcherService.dispatchEvent('latency.spike' as WebhookEventType, data);
  }

  /**
   * Dispatch connection spike event
   */
  async dispatchConnectionSpike(data: {
    currentConnections: number;
    baseline: number;
    threshold: number;
    timestamp: number;
    instance: { host: string; port: number };
  }): Promise<void> {
    await this.dispatcherService.dispatchEvent('connection.spike' as WebhookEventType, data);
  }

  /**
   * Dispatch client blocked event
   */
  async dispatchClientBlocked(data: {
    clientId: string;
    blockedFor: number;
    reason: string;
    timestamp: number;
  }): Promise<void> {
    await this.dispatcherService.dispatchEvent('client.blocked' as WebhookEventType, data);
  }

  /**
   * Generic method to dispatch operational events
   */
  async dispatchOperationalEvent(
    eventType: WebhookEventType,
    data: Record<string, any>,
  ): Promise<void> {
    try {
      await this.dispatcherService.dispatchEvent(eventType, data);
      this.logger.debug(`Dispatched operational event: ${eventType}`);
    } catch (error) {
      this.logger.error(`Failed to dispatch operational event ${eventType}:`, error);
    }
  }
}
