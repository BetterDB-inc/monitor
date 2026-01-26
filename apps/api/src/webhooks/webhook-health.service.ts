import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Webhook, WebhookDelivery } from '@betterdb/shared';
import { DeliveryStatus } from '@betterdb/shared';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhooksService } from './webhooks.service';

interface WebhookHealthMetrics {
  webhookId: string;
  successRate: number;
  totalDeliveries: number;
  successfulDeliveries: number;
  failedDeliveries: number;
  lastDeliveryAt?: number;
  consecutiveFailures: number;
  isHealthy: boolean;
}

@Injectable()
export class WebhookHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookHealthService.name);
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private readonly HEALTH_CHECK_INTERVAL_MS = 300000; // 5 minutes
  private readonly UNHEALTHY_THRESHOLD = 0.5; // 50% success rate
  private readonly CONSECUTIVE_FAILURES_THRESHOLD = 5;
  private readonly AUTO_DISABLE_ENABLED = true;

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storageClient: StoragePort,
    private readonly webhooksService: WebhooksService,
  ) {}

  async onModuleInit() {
    this.logger.log('Starting webhook health monitor service');
    this.startHealthMonitor();
  }

  onModuleDestroy() {
    this.logger.log('Stopping webhook health monitor service');
    this.stopHealthMonitor();
  }

  /**
   * Start the health monitor background job
   */
  private startHealthMonitor(): void {
    this.healthCheckInterval = setInterval(() => {
      this.checkAllWebhooksHealth().catch(error => {
        this.logger.error('Error in health monitor:', error);
      });
    }, this.HEALTH_CHECK_INTERVAL_MS);

    // Run immediately on start
    this.checkAllWebhooksHealth().catch(error => {
      this.logger.error('Error in initial health check:', error);
    });
  }

  /**
   * Stop the health monitor
   */
  private stopHealthMonitor(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Check health of all webhooks
   */
  async checkAllWebhooksHealth(): Promise<void> {
    try {
      const webhooks = await this.webhooksService.getAllWebhooks();

      if (webhooks.length === 0) {
        this.logger.debug('No webhooks to monitor');
        return;
      }

      this.logger.debug(`Checking health of ${webhooks.length} webhook(s)`);

      // Check health for each webhook
      const healthChecks = await Promise.all(
        webhooks.map(webhook => this.checkWebhookHealth(webhook))
      );

      // Auto-disable unhealthy webhooks if enabled
      if (this.AUTO_DISABLE_ENABLED) {
        const unhealthyWebhooks = healthChecks.filter(metrics => !metrics.isHealthy);

        for (const metrics of unhealthyWebhooks) {
          await this.handleUnhealthyWebhook(metrics);
        }
      }

    } catch (error) {
      this.logger.error('Failed to check webhooks health:', error);
    }
  }

  /**
   * Check health of a single webhook
   */
  async checkWebhookHealth(webhook: Webhook): Promise<WebhookHealthMetrics> {
    try {
      // Get recent deliveries (last 100)
      const deliveries = await this.storageClient.getDeliveriesByWebhook(webhook.id, 100);

      if (deliveries.length === 0) {
        return {
          webhookId: webhook.id,
          successRate: 1.0, // No deliveries = healthy by default
          totalDeliveries: 0,
          successfulDeliveries: 0,
          failedDeliveries: 0,
          consecutiveFailures: 0,
          isHealthy: true,
        };
      }

      // Calculate metrics
      const successfulDeliveries = deliveries.filter(d => d.status === DeliveryStatus.SUCCESS).length;
      const failedDeliveries = deliveries.filter(d => d.status === DeliveryStatus.FAILED).length;
      const totalDeliveries = deliveries.length;
      const successRate = successfulDeliveries / totalDeliveries;

      // Check for consecutive failures
      const consecutiveFailures = this.countConsecutiveFailures(deliveries);

      // Determine health status
      const isHealthy =
        successRate >= this.UNHEALTHY_THRESHOLD &&
        consecutiveFailures < this.CONSECUTIVE_FAILURES_THRESHOLD;

      const lastDeliveryAt = deliveries[0]?.createdAt;

      return {
        webhookId: webhook.id,
        successRate,
        totalDeliveries,
        successfulDeliveries,
        failedDeliveries,
        lastDeliveryAt,
        consecutiveFailures,
        isHealthy,
      };

    } catch (error) {
      this.logger.error(`Failed to check health for webhook ${webhook.id}:`, error);
      return {
        webhookId: webhook.id,
        successRate: 0,
        totalDeliveries: 0,
        successfulDeliveries: 0,
        failedDeliveries: 0,
        consecutiveFailures: 0,
        isHealthy: false,
      };
    }
  }

  /**
   * Count consecutive failures from most recent deliveries
   */
  private countConsecutiveFailures(deliveries: WebhookDelivery[]): number {
    // Sort by creation time (newest first)
    const sorted = [...deliveries].sort((a, b) => b.createdAt - a.createdAt);

    let consecutiveFailures = 0;
    for (const delivery of sorted) {
      if (delivery.status === DeliveryStatus.FAILED) {
        consecutiveFailures++;
      } else if (delivery.status === DeliveryStatus.SUCCESS) {
        break;
      }
    }

    return consecutiveFailures;
  }

  /**
   * Handle unhealthy webhook
   */
  private async handleUnhealthyWebhook(metrics: WebhookHealthMetrics): Promise<void> {
    try {
      const webhook = await this.webhooksService.getWebhook(metrics.webhookId);

      // Skip if already disabled
      if (!webhook.enabled) {
        return;
      }

      this.logger.warn(
        `Webhook ${webhook.id} (${webhook.name}) is unhealthy: ` +
        `success rate ${(metrics.successRate * 100).toFixed(1)}%, ` +
        `${metrics.consecutiveFailures} consecutive failures. ` +
        `Auto-disabling webhook.`
      );

      // Disable the webhook
      await this.webhooksService.updateWebhook(webhook.id, { enabled: false });

      this.logger.log(`Webhook ${webhook.id} has been automatically disabled due to poor health`);

    } catch (error) {
      this.logger.error(`Failed to handle unhealthy webhook ${metrics.webhookId}:`, error);
    }
  }

  /**
   * Get health metrics for a specific webhook
   */
  async getWebhookHealthMetrics(webhookId: string): Promise<WebhookHealthMetrics> {
    const webhook = await this.webhooksService.getWebhook(webhookId);
    return this.checkWebhookHealth(webhook);
  }

  /**
   * Get health metrics for all webhooks
   */
  async getAllWebhookHealthMetrics(): Promise<WebhookHealthMetrics[]> {
    const webhooks = await this.webhooksService.getAllWebhooks();
    return Promise.all(webhooks.map(webhook => this.checkWebhookHealth(webhook)));
  }

  /**
   * Get health summary statistics
   */
  async getHealthSummary(): Promise<{
    totalWebhooks: number;
    healthyWebhooks: number;
    unhealthyWebhooks: number;
    disabledWebhooks: number;
    overallSuccessRate: number;
  }> {
    const webhooks = await this.webhooksService.getAllWebhooks();
    const metrics = await Promise.all(webhooks.map(webhook => this.checkWebhookHealth(webhook)));

    const healthyWebhooks = metrics.filter(m => m.isHealthy).length;
    const unhealthyWebhooks = metrics.filter(m => !m.isHealthy).length;
    const disabledWebhooks = webhooks.filter(w => !w.enabled).length;

    const totalSuccessful = metrics.reduce((sum, m) => sum + m.successfulDeliveries, 0);
    const totalDeliveries = metrics.reduce((sum, m) => sum + m.totalDeliveries, 0);
    const overallSuccessRate = totalDeliveries > 0 ? totalSuccessful / totalDeliveries : 1.0;

    return {
      totalWebhooks: webhooks.length,
      healthyWebhooks,
      unhealthyWebhooks,
      disabledWebhooks,
      overallSuccessRate,
    };
  }
}
