import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookProService } from './webhook-pro.service';
import type { StoragePort, StoredAnomalyEvent, StoredCorrelatedGroup } from '@app/common/interfaces/storage-port.interface';
import type { AnomalyWebhookSink } from '../anomaly-detection/types';

/**
 * Webhook Anomaly Integration Service
 *
 * Integrates webhook dispatching with anomaly detection.
 * AnomalyService hands each event over after its first successful save.
 */
@Injectable()
export class WebhookAnomalyIntegrationService implements AnomalyWebhookSink {
  private readonly logger = new Logger(WebhookAnomalyIntegrationService.name);

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly webhookProService: WebhookProService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Dispatch webhook for an anomaly event
   */
  async dispatchAnomalyWebhook(anomaly: StoredAnomalyEvent): Promise<void> {
    try {
      // command_p99 regressions and replication divergence each have a dedicated event
      // (latency.regression.detected, replication.divergence); skip the generic
      // anomaly.detected here so one incident doesn't produce two Pro webhook deliveries.
      if (anomaly.metricType === 'command_p99' || anomaly.metricType === 'replication_divergence') {
        return;
      }

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
