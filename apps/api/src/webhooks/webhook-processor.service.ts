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

  // Retry processing configuration
  // 10 second interval: Balances responsiveness vs. database load
  // - Fast enough for most retry delays (1s, 2s, 4s initial backoff)
  // - Slow enough to avoid constant polling overhead
  // - TODO: Consider adaptive polling (faster when retries pending)
  private readonly RETRY_CHECK_INTERVAL_MS = 10_000;

  // Max 10 concurrent retries: Prevents overwhelming downstream webhooks
  // - Limits parallel HTTP requests to avoid socket exhaustion
  // - Limits concurrent database writes for delivery updates
  // - Prevents memory pressure from many in-flight requests
  // - Scale this up for high-throughput deployments (50-100)
  private readonly MAX_CONCURRENT_RETRIES = 10;

  // Graceful shutdown timeout (30 seconds)
  // Allows in-flight webhook deliveries to complete before forcing shutdown
  // - Most webhooks timeout at 30s, so this matches typical max duration
  // - Prevents data loss (delivery records get marked failed on interrupt)
  private readonly GRACEFUL_SHUTDOWN_TIMEOUT_MS = 30_000;

  // Shutdown polling interval (100ms)
  // How often to check if active retries completed during graceful shutdown
  // - 100ms is responsive enough (users won't notice)
  // - Light enough to not add significant CPU load during shutdown
  private readonly SHUTDOWN_CHECK_INTERVAL_MS = 100;

  private isProcessing = false;
  private activeRetries = 0;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly webhooksService: WebhooksService,
    private readonly dispatcherService: WebhookDispatcherService,
  ) {}

  async onModuleInit() {
    this.logger.log('Starting webhook processor service');
    this.startRetryProcessor();
  }

  async onModuleDestroy() {
    this.logger.log('Stopping webhook processor service');
    this.stopRetryProcessor();

    // Gracefully wait for active retries to complete
    if (this.activeRetries > 0) {
      this.logger.log(`Waiting for ${this.activeRetries} active retries to complete...`);
      this.shutdownPromise = new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.activeRetries === 0) {
            clearInterval(checkInterval);
            this.logger.log('All active retries completed');
            resolve();
          }
        }, this.SHUTDOWN_CHECK_INTERVAL_MS);

        // Timeout after configured duration
        setTimeout(() => {
          clearInterval(checkInterval);
          this.logger.warn(`Forced shutdown with ${this.activeRetries} active retries remaining`);
          resolve();
        }, this.GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      });

      await this.shutdownPromise;
    }
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
    this.activeRetries++;
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
    } finally {
      this.activeRetries--;
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

    // Get webhook to check retry policy
    const webhook = await this.webhooksService.getWebhook(delivery.webhookId);

    // Check if max retries already exceeded
    if (delivery.attempts >= webhook.retryPolicy.maxRetries) {
      throw new Error(
        `Cannot retry: max attempts reached (${delivery.attempts}/${webhook.retryPolicy.maxRetries})`
      );
    }

    // Reset delivery for retry
    await this.storageClient.updateDelivery(deliveryId, {
      status: DeliveryStatus.RETRYING,
      nextRetryAt: Date.now(),
    });

    this.logger.log(`Manual retry queued for delivery ${deliveryId} (attempt ${delivery.attempts + 1}/${webhook.retryPolicy.maxRetries})`);

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
