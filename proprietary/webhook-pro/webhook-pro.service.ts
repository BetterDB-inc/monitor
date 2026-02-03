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
    connectionId?: string;
  }): Promise<void> {
    const { connectionId, ...eventData } = data;
    await this.dispatcherService.dispatchEvent('anomaly.detected' as WebhookEventType, eventData, connectionId);
  }

  /**
   * Dispatch slowlog threshold event
   */
  async dispatchSlowlogThreshold(data: {
    slowlogCount: number;
    threshold: number;
    timestamp: number;
    connectionId?: string;
  }): Promise<void> {
    const { connectionId, ...eventData } = data;
    await this.dispatcherService.dispatchEvent('slowlog.threshold' as WebhookEventType, eventData, connectionId);
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
    connectionId?: string;
  }): Promise<void> {
    const { connectionId, ...eventData } = data;
    await this.dispatcherService.dispatchEvent('latency.spike' as WebhookEventType, eventData, connectionId);
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
    connectionId?: string;
  }): Promise<void> {
    const { connectionId, ...eventData } = data;
    await this.dispatcherService.dispatchEvent('connection.spike' as WebhookEventType, eventData, connectionId);
  }

  /**
   * Dispatch client blocked event
   */
  async dispatchClientBlocked(data: {
    clientId: string;
    blockedFor: number;
    reason: string;
    timestamp: number;
    connectionId?: string;
  }): Promise<void> {
    const { connectionId, ...eventData } = data;
    await this.dispatcherService.dispatchEvent('client.blocked' as WebhookEventType, eventData, connectionId);
  }

  /**
   * Generic method to dispatch operational events
   */
  async dispatchOperationalEvent(
    eventType: WebhookEventType,
    data: Record<string, any>,
    connectionId?: string,
  ): Promise<void> {
    try {
      await this.dispatcherService.dispatchEvent(eventType, data, connectionId);
      this.logger.debug(`Dispatched operational event: ${eventType}`);
    } catch (error) {
      this.logger.error(`Failed to dispatch operational event ${eventType}:`, error);
    }
  }
}
