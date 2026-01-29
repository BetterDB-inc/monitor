import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Webhook, WebhookDelivery } from '@betterdb/shared';
import { DeliveryStatus } from '@betterdb/shared';
import type { StoragePort } from '@app/common/interfaces/storage-port.interface';

/** Default max retries if webhook not found or has no retry policy */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Webhook Dead Letter Queue (DLQ) Service - Enterprise Tier
 *
 * Handles failed webhook deliveries that have exceeded maximum retries.
 * Provides storage and retrieval of dead-lettered deliveries for manual
 * intervention and analysis.
 */
@Injectable()
export class WebhookDlqService {
  private readonly logger = new Logger(WebhookDlqService.name);
  // Cache webhooks to avoid repeated lookups
  private webhookCache: Map<string, Webhook | null> = new Map();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
  ) {}

  /**
   * Get max retries for a webhook, using cache to reduce DB lookups
   */
  private async getMaxRetriesForWebhook(webhookId: string): Promise<number> {
    // Check cache first
    if (this.webhookCache.has(webhookId)) {
      const cached = this.webhookCache.get(webhookId);
      return cached?.retryPolicy?.maxRetries ?? DEFAULT_MAX_RETRIES;
    }

    // Lookup webhook
    const webhook = await this.storageClient.getWebhook(webhookId);
    this.webhookCache.set(webhookId, webhook);

    // Clear cache after 60 seconds to allow for config changes
    setTimeout(() => this.webhookCache.delete(webhookId), 60000);

    return webhook?.retryPolicy?.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /**
   * Check if a delivery has exceeded its webhook's max retries
   */
  private async isDeadLettered(delivery: WebhookDelivery): Promise<boolean> {
    if (delivery.status !== DeliveryStatus.FAILED) {
      return false;
    }
    const maxRetries = await this.getMaxRetriesForWebhook(delivery.webhookId);
    return delivery.attempts >= maxRetries;
  }

  /**
   * Get all dead-lettered deliveries
   * (Deliveries that have status 'failed' and have reached max retries)
   */
  async getDeadLetteredDeliveries(limit: number = 100): Promise<WebhookDelivery[]> {
    try {
      // In a production system, we might want to add a separate 'dead_letter' status
      // For now, we'll identify DLQ items as failed deliveries with maxed out attempts
      const allDeliveries = await this.getRecentFailedDeliveries(limit * 2);

      // Filter for deliveries that have truly failed (not just retrying)
      // Uses per-webhook maxRetries configuration
      const deadLetteredChecks = await Promise.all(
        allDeliveries.map(async delivery => ({
          delivery,
          isDeadLettered: await this.isDeadLettered(delivery),
        }))
      );

      const deadLettered = deadLetteredChecks
        .filter(item => item.isDeadLettered)
        .map(item => item.delivery);

      return deadLettered.slice(0, limit);

    } catch (error) {
      this.logger.error('Failed to get dead-lettered deliveries:', error);
      throw error;
    }
  }

  /**
   * Get recent failed deliveries
   */
  private async getRecentFailedDeliveries(limit: number): Promise<WebhookDelivery[]> {
    // This is a simplified implementation
    // In a real system, you'd have a dedicated query in the storage layer
    // For now, we'll use a workaround to get failed deliveries
    const deliveries: WebhookDelivery[] = [];

    // Get all webhooks to query their deliveries
    const webhooks = await this.storageClient.getWebhooksByInstance();

    for (const webhook of webhooks) {
      const webhookDeliveries = await this.storageClient.getDeliveriesByWebhook(webhook.id, limit);
      const failedDeliveries = webhookDeliveries.filter(d => d.status === DeliveryStatus.FAILED);
      deliveries.push(...failedDeliveries);
    }

    // Sort by creation time (newest first) and limit
    return deliveries
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * Get dead-lettered deliveries for a specific webhook
   */
  async getDeadLetteredDeliveriesForWebhook(
    webhookId: string,
    limit: number = 100
  ): Promise<WebhookDelivery[]> {
    try {
      const deliveries = await this.storageClient.getDeliveriesByWebhook(webhookId, limit * 2);

      // Get maxRetries for this specific webhook
      const maxRetries = await this.getMaxRetriesForWebhook(webhookId);

      const deadLettered = deliveries.filter(delivery => {
        return delivery.status === DeliveryStatus.FAILED && delivery.attempts >= maxRetries;
      });

      return deadLettered.slice(0, limit);

    } catch (error) {
      this.logger.error(`Failed to get dead-lettered deliveries for webhook ${webhookId}:`, error);
      throw error;
    }
  }

  /**
   * Get DLQ statistics
   */
  async getDlqStats(): Promise<{
    totalDeadLettered: number;
    byWebhook: Record<string, number>;
    byEvent: Record<string, number>;
    oldestDeadLetteredAt: number | null;
  }> {
    try {
      const deadLettered = await this.getDeadLetteredDeliveries(1000);

      const byWebhook: Record<string, number> = {};
      const byEvent: Record<string, number> = {};
      let oldestDeadLetteredAt: number | null = null;

      for (const delivery of deadLettered) {
        byWebhook[delivery.webhookId] = (byWebhook[delivery.webhookId] || 0) + 1;
        byEvent[delivery.eventType] = (byEvent[delivery.eventType] || 0) + 1;

        if (!oldestDeadLetteredAt || delivery.createdAt < oldestDeadLetteredAt) {
          oldestDeadLetteredAt = delivery.createdAt;
        }
      }

      return {
        totalDeadLettered: deadLettered.length,
        byWebhook,
        byEvent,
        oldestDeadLetteredAt,
      };

    } catch (error) {
      this.logger.error('Failed to get DLQ stats:', error);
      throw error;
    }
  }

  /**
   * Purge old dead-lettered deliveries
   */
  async purgeDlqDeliveries(olderThanDays: number = 90): Promise<number> {
    try {
      const cutoffTimestamp = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

      // Get all dead-lettered deliveries
      const deadLettered = await this.getDeadLetteredDeliveries(10000);

      // Filter by age
      const toPurge = deadLettered.filter(d => d.createdAt < cutoffTimestamp);

      // Note: In a real implementation, we would batch delete these
      // For now, we're just returning the count that would be purged
      // The actual pruning is done by the storage layer's pruneOldDeliveries method

      this.logger.log(`Would purge ${toPurge.length} dead-lettered deliveries older than ${olderThanDays} days`);

      return toPurge.length;

    } catch (error) {
      this.logger.error('Failed to purge DLQ deliveries:', error);
      throw error;
    }
  }

  /**
   * Requeue a dead-lettered delivery for retry
   * This allows manual intervention to retry a failed delivery
   */
  async requeueDelivery(deliveryId: string): Promise<void> {
    try {
      const delivery = await this.storageClient.getDelivery(deliveryId);

      if (!delivery) {
        throw new Error(`Delivery ${deliveryId} not found`);
      }

      if (delivery.status !== DeliveryStatus.FAILED) {
        throw new Error(`Delivery ${deliveryId} is not in failed state`);
      }

      // Reset the delivery for retry
      await this.storageClient.updateDelivery(deliveryId, {
        status: DeliveryStatus.RETRYING,
        nextRetryAt: Date.now(),
        attempts: 0, // Reset attempts to allow retry
      });

      this.logger.log(`Requeued dead-lettered delivery ${deliveryId} for retry`);

    } catch (error) {
      this.logger.error(`Failed to requeue delivery ${deliveryId}:`, error);
      throw error;
    }
  }

  /**
   * Export dead-lettered deliveries for analysis
   * Returns deliveries in a format suitable for export
   */
  async exportDeadLetteredDeliveries(
    startTime?: number,
    endTime?: number
  ): Promise<Array<{
    deliveryId: string;
    webhookId: string;
    eventType: string;
    attempts: number;
    failureReason: string;
    createdAt: number;
    completedAt: number | undefined;
  }>> {
    try {
      const deadLettered = await this.getDeadLetteredDeliveries(10000);

      let filtered = deadLettered;
      if (startTime) {
        filtered = filtered.filter(d => d.createdAt >= startTime);
      }
      if (endTime) {
        filtered = filtered.filter(d => d.createdAt <= endTime);
      }

      return filtered.map(delivery => ({
        deliveryId: delivery.id,
        webhookId: delivery.webhookId,
        eventType: delivery.eventType,
        attempts: delivery.attempts,
        failureReason: delivery.responseBody || 'Unknown error',
        createdAt: delivery.createdAt,
        completedAt: delivery.completedAt,
      }));

    } catch (error) {
      this.logger.error('Failed to export dead-lettered deliveries:', error);
      throw error;
    }
  }
}
