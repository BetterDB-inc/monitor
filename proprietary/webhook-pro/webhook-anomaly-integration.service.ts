import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookProService } from './webhook-pro.service';
import type { StoragePort, StoredAnomalyEvent, StoredCorrelatedGroup } from '@app/common/interfaces/storage-port.interface';

/**
 * Webhook Anomaly Integration Service
 *
 * Integrates webhook dispatching with anomaly detection.
 * Dispatches webhooks when anomalies and correlated groups are detected.
 */
@Injectable()
export class WebhookAnomalyIntegrationService implements OnModuleInit {
  private readonly logger = new Logger(WebhookAnomalyIntegrationService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly POLL_INTERVAL_MS = 5000; // Check every 5 seconds
  private lastCheckedTimestamp: number = Date.now();

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly webhookProService: WebhookProService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    this.logger.log('Webhook anomaly integration service initialized');
    this.startPolling();
  }

  onModuleDestroy() {
    this.stopPolling();
  }

  /**
   * Start polling for new anomalies
   */
  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.checkForNewAnomalies().catch(error => {
        this.logger.error('Error checking for new anomalies:', error);
      });
    }, this.POLL_INTERVAL_MS);

    // Run immediately on start
    this.checkForNewAnomalies().catch(error => {
      this.logger.error('Error in initial anomaly check:', error);
    });
  }

  /**
   * Stop polling
   */
  private stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Check for new anomalies and dispatch webhooks
   */
  private async checkForNewAnomalies(): Promise<void> {
    try {
      const currentTime = Date.now();

      // Get anomalies since last check
      const anomalies = await this.storage.getAnomalyEvents({
        startTime: this.lastCheckedTimestamp,
        endTime: currentTime,
        limit: 1000,
      });

      if (anomalies.length > 0) {
        this.logger.debug(`Found ${anomalies.length} new anomalies to process`);

        // Dispatch webhooks for each anomaly
        for (const anomaly of anomalies) {
          await this.dispatchAnomalyWebhook(anomaly);
        }
      }

      // Update last checked timestamp
      this.lastCheckedTimestamp = currentTime;

    } catch (error) {
      this.logger.error('Failed to check for new anomalies:', error);
    }
  }

  /**
   * Dispatch webhook for an anomaly event
   */
  private async dispatchAnomalyWebhook(anomaly: StoredAnomalyEvent): Promise<void> {
    try {
      const data = {
        anomalyId: anomaly.id,
        metricType: anomaly.metricType,
        anomalyType: anomaly.anomalyType,
        severity: anomaly.severity,
        value: anomaly.value,
        baseline: anomaly.baseline,
        stdDev: anomaly.stdDev,
        zScore: anomaly.zScore,
        threshold: anomaly.threshold,
        message: anomaly.message,
        timestamp: anomaly.timestamp,
        sourceHost: anomaly.sourceHost,
        sourcePort: anomaly.sourcePort,
        connectionId: anomaly.connectionId,
      };

      // Always dispatch the generic anomaly.detected event
      await this.webhookProService.dispatchAnomalyDetected(data);

      // Dispatch specific spike events for connection and latency metrics
      if (anomaly.metricType === 'connections' && anomaly.anomalyType === 'spike') {
        await this.webhookProService.dispatchConnectionSpike({
          currentConnections: anomaly.value,
          baseline: anomaly.baseline,
          threshold: anomaly.threshold,
          timestamp: anomaly.timestamp,
          instance: { host: anomaly.sourceHost || 'unknown', port: anomaly.sourcePort || 0 },
          connectionId: anomaly.connectionId,
        });
        this.logger.debug(`Dispatched connection.spike for anomaly ${anomaly.id}`);
      }

      // Latency spike = drop in ops_per_sec (fewer operations = higher latency per operation)
      if (anomaly.metricType === 'ops_per_sec' && anomaly.anomalyType === 'drop') {
        await this.webhookProService.dispatchLatencySpike({
          currentLatency: anomaly.baseline > 0 ? anomaly.baseline / anomaly.value : 0,
          baseline: 1.0, // Normalized baseline
          threshold: anomaly.threshold,
          timestamp: anomaly.timestamp,
          instance: { host: anomaly.sourceHost || 'unknown', port: anomaly.sourcePort || 0 },
          connectionId: anomaly.connectionId,
        });
        this.logger.debug(`Dispatched latency.spike for anomaly ${anomaly.id}`);
      }

      this.logger.debug(
        `Dispatched webhook for anomaly ${anomaly.id}: ${anomaly.metricType} (${anomaly.severity})`
      );

    } catch (error) {
      this.logger.error(`Failed to dispatch webhook for anomaly ${anomaly.id}:`, error);
    }
  }

  /**
   * Manually dispatch webhook for a specific anomaly
   */
  async dispatchAnomalyById(anomalyId: string): Promise<void> {
    try {
      const anomalies = await this.storage.getAnomalyEvents({ limit: 1000 });
      const anomaly = anomalies.find(a => a.id === anomalyId);

      if (!anomaly) {
        throw new Error(`Anomaly ${anomalyId} not found`);
      }

      await this.dispatchAnomalyWebhook(anomaly);

      this.logger.log(`Manually dispatched webhook for anomaly ${anomalyId}`);

    } catch (error) {
      this.logger.error(`Failed to manually dispatch webhook for anomaly ${anomalyId}:`, error);
      throw error;
    }
  }
}
