import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { WebhookDelivery } from '@betterdb/shared';
import { DeliveryStatus } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhooksService } from './webhooks.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

@Injectable()
export class WebhookProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookProcessorService.name);
  private retryInterval: NodeJS.Timeout | null = null;
  private readonly RETRY_CHECK_INTERVAL_MS = 10000; // Check every 10 seconds
  private readonly MAX_CONCURRENT_RETRIES = 10;
  private isProcessing = false;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly webhooksService: WebhooksService,
    private readonly dispatcherService: WebhookDispatcherService,
  ) {}

  async onModuleInit() {
    this.logger.log('Starting webhook processor service');
    this.startRetryProcessor();
  }

  onModuleDestroy() {
    this.logger.log('Stopping webhook processor service');
    this.stopRetryProcessor();
  }

  /**
   * Start the retry processor background job
   */
  private startRetryProcessor(): void {
    this.retryInterval = setInterval(() => {
      this.processRetries().catch(error => {
        this.logger.error('Error in retry processor:', error);
      });
    }, this.RETRY_CHECK_INTERVAL_MS);

    // Run immediately on start
    this.processRetries().catch(error => {
      this.logger.error('Error in initial retry processor run:', error);
    });
  }

  /**
   * Stop the retry processor
   */
  private stopRetryProcessor(): void {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
  }

  /**
   * Process pending retries
   */
  async processRetries(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) {
      this.logger.debug('Retry processing already in progress, skipping');
      return;
    }

    this.isProcessing = true;

    try {
      // Get deliveries that are ready for retry
      const retriableDeliveries = await this.storageClient.getRetriableDeliveries(
        this.MAX_CONCURRENT_RETRIES
      );

      if (retriableDeliveries.length === 0) {
        this.logger.debug('No deliveries ready for retry');
        return;
      }

      this.logger.log(`Processing ${retriableDeliveries.length} delivery retries`);

      // Process retries in parallel with limit
      await Promise.allSettled(
        retriableDeliveries.map(delivery => this.retryDelivery(delivery))
      );

    } catch (error) {
      this.logger.error('Failed to process retries:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Retry a single delivery
   */
  private async retryDelivery(delivery: WebhookDelivery): Promise<void> {
    try {
      this.logger.debug(
        `Retrying delivery ${delivery.id} (attempt ${delivery.attempts + 1})`
      );

      // Get webhook details
      const webhook = await this.webhooksService.getWebhook(delivery.webhookId);

      // Check if webhook is still enabled
      if (!webhook.enabled) {
        this.logger.debug(`Webhook ${webhook.id} is disabled, marking delivery as failed`);
        await this.storageClient.updateDelivery(delivery.id, {
          status: DeliveryStatus.FAILED,
          completedAt: Date.now(),
          responseBody: 'Webhook disabled',
        });
        return;
      }

      // Send webhook
      await this.dispatcherService.sendWebhook(webhook, delivery.id, delivery.payload);

    } catch (error: any) {
      this.logger.error(`Failed to retry delivery ${delivery.id}:`, error);

      // Mark as failed if we can't retry
      await this.storageClient.updateDelivery(delivery.id, {
        status: DeliveryStatus.FAILED,
        completedAt: Date.now(),
        responseBody: error.message || 'Retry failed',
      }).catch(updateError => {
        this.logger.error(`Failed to update delivery ${delivery.id}:`, updateError);
      });
    }
  }

  /**
   * Manually retry a failed delivery
   */
  async manualRetry(deliveryId: string): Promise<void> {
    const delivery = await this.storageClient.getDelivery(deliveryId);

    if (!delivery) {
      throw new Error(`Delivery ${deliveryId} not found`);
    }

    if (delivery.status === DeliveryStatus.SUCCESS) {
      throw new Error('Cannot retry successful delivery');
    }

    // Reset delivery for retry
    await this.storageClient.updateDelivery(deliveryId, {
      status: DeliveryStatus.RETRYING,
      nextRetryAt: Date.now(),
    });

    this.logger.log(`Manual retry queued for delivery ${deliveryId}`);

    // Trigger immediate processing
    await this.retryDelivery(delivery);
  }

  /**
   * Get retry queue statistics
   */
  async getRetryStats(): Promise<{
    pendingRetries: number;
    nextRetryTime: number | null;
  }> {
    const retriableDeliveries = await this.storageClient.getRetriableDeliveries(1000);

    const pendingRetries = retriableDeliveries.length;
    const nextRetryTime = retriableDeliveries.length > 0
      ? Math.min(...retriableDeliveries.map(d => d.nextRetryAt || Date.now()))
      : null;

    return {
      pendingRetries,
      nextRetryTime,
    };
  }
}
