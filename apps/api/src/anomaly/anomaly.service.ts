import { Injectable, Logger, OnModuleInit, OnModuleDestroy, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabasePort } from '../common/interfaces/database-port.interface';
import { MetricBuffer } from './metric-buffer';
import { SpikeDetector } from './spike-detector';
import { Correlator } from './correlator';
import {
  MetricType,
  AnomalyEvent,
  CorrelatedAnomalyGroup,
  AnomalySeverity,
  AnomalyPattern,
  BufferStats,
  AnomalySummary,
  SpikeDetectorConfig,
} from './types';

interface MetricExtractor {
  (info: Record<string, string>): number | null;
}

@Injectable()
export class AnomalyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnomalyService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private correlationInterval: NodeJS.Timeout | null = null;

  private buffers = new Map<MetricType, MetricBuffer>();
  private detectors = new Map<MetricType, SpikeDetector>();
  private correlator: Correlator;

  private recentAnomalies: AnomalyEvent[] = [];
  private recentGroups: CorrelatedAnomalyGroup[] = [];
  private readonly maxRecentEvents = 1000;
  private readonly maxRecentGroups = 100;

  private readonly metricExtractors: Map<MetricType, MetricExtractor>;
  private readonly pollIntervalMs = 1000; // 1 second
  private readonly correlationIntervalMs = 5000; // 5 seconds

  constructor(
    @Inject('DATABASE_CLIENT')
    private readonly dbClient: DatabasePort,
    private readonly configService: ConfigService,
  ) {
    this.correlator = new Correlator(this.correlationIntervalMs);
    this.metricExtractors = this.initializeMetricExtractors();
    this.initializeBuffersAndDetectors();
  }

  onModuleInit() {
    this.logger.log('Starting anomaly detection service...');
    this.startPolling();
    this.startCorrelation();
  }

  onModuleDestroy() {
    this.logger.log('Stopping anomaly detection service...');
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
    if (this.correlationInterval) {
      clearInterval(this.correlationInterval);
    }
  }

  private initializeMetricExtractors(): Map<MetricType, MetricExtractor> {
    return new Map<MetricType, MetricExtractor>([
      [MetricType.CONNECTIONS, (info) => this.parseNumber(info.connected_clients)],
      [MetricType.OPS_PER_SEC, (info) => this.parseNumber(info.instantaneous_ops_per_sec)],
      [MetricType.MEMORY_USED, (info) => this.parseNumber(info.used_memory)],
      [MetricType.INPUT_KBPS, (info) => this.parseNumber(info.instantaneous_input_kbps)],
      [MetricType.OUTPUT_KBPS, (info) => this.parseNumber(info.instantaneous_output_kbps)],
      [MetricType.SLOWLOG_COUNT, (info) => this.parseNumber(info.slowlog_len)],
      [MetricType.ACL_DENIED, (info) => {
        const rejected = this.parseNumber(info.rejected_connections);
        const aclDenied = this.parseNumber(info.acl_access_denied_auth);
        return (rejected || 0) + (aclDenied || 0);
      }],
      [MetricType.EVICTED_KEYS, (info) => this.parseNumber(info.evicted_keys)],
      [MetricType.BLOCKED_CLIENTS, (info) => this.parseNumber(info.blocked_clients)],
      [MetricType.KEYSPACE_MISSES, (info) => this.parseNumber(info.keyspace_misses)],
      [MetricType.FRAGMENTATION_RATIO, (info) => this.parseNumber(info.mem_fragmentation_ratio)],
    ]);
  }

  private initializeBuffersAndDetectors(): void {
    // Define custom configs for specific metrics
    const configs: Partial<Record<MetricType, SpikeDetectorConfig>> = {
      [MetricType.ACL_DENIED]: {
        warningZScore: 1.5,
        criticalZScore: 2.5,
        warningThreshold: 10,
        criticalThreshold: 50,
        consecutiveRequired: 2,
        cooldownMs: 30000,
      },
      [MetricType.SLOWLOG_COUNT]: {
        warningZScore: 1.5,
        criticalZScore: 2.5,
        consecutiveRequired: 2,
        cooldownMs: 30000,
      },
      [MetricType.MEMORY_USED]: {
        warningZScore: 2.5,
        criticalZScore: 3.5,
        consecutiveRequired: 3,
        cooldownMs: 60000,
      },
      [MetricType.EVICTED_KEYS]: {
        warningZScore: 2.0,
        criticalZScore: 3.0,
        consecutiveRequired: 2,
        cooldownMs: 30000,
      },
      [MetricType.FRAGMENTATION_RATIO]: {
        warningZScore: 2.0,
        criticalZScore: 3.0,
        warningThreshold: 1.5,
        criticalThreshold: 2.0,
        consecutiveRequired: 5,
        cooldownMs: 120000,
      },
    };

    // Initialize buffers and detectors for all metrics
    for (const metricType of Object.values(MetricType)) {
      this.buffers.set(metricType, new MetricBuffer(metricType));
      const config = configs[metricType] || {};
      this.detectors.set(metricType, new SpikeDetector(metricType, config));
    }
  }

  private parseNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  private startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.pollMetrics().catch(err => {
        this.logger.error('Error polling metrics:', err);
      });
    }, this.pollIntervalMs);

    // Run immediately
    this.pollMetrics().catch(err => {
      this.logger.error('Error in initial poll:', err);
    });
  }

  private async pollMetrics(): Promise<void> {
    try {
      const infoResponse = await this.dbClient.getInfoParsed();
      const info = this.convertInfoToRecord(infoResponse);
      const timestamp = Date.now();

      // Process each metric
      for (const [metricType, extractor] of this.metricExtractors.entries()) {
        const value = extractor(info);
        if (value === null) continue;

        const buffer = this.buffers.get(metricType);
        const detector = this.detectors.get(metricType);

        if (!buffer || !detector) continue;

        // Add sample to buffer
        buffer.addSample(value, timestamp);

        // Run detection
        const anomaly = detector.detect(buffer, value, timestamp);
        if (anomaly) {
          this.logger.warn(`Anomaly detected: ${anomaly.message}`);
          this.addAnomaly(anomaly);
        }
      }
    } catch (error) {
      this.logger.error('Failed to poll metrics:', error);
    }
  }

  private convertInfoToRecord(infoResponse: any): Record<string, string> {
    const info: Record<string, string> = {};

    // Flatten all sections into a single record
    for (const section of Object.values(infoResponse)) {
      if (typeof section === 'object' && section !== null) {
        Object.assign(info, section);
      }
    }

    // Convert all values to strings
    for (const key of Object.keys(info)) {
      if (typeof info[key] !== 'string') {
        info[key] = String(info[key]);
      }
    }

    return info;
  }

  private addAnomaly(anomaly: AnomalyEvent): void {
    this.recentAnomalies.push(anomaly);

    // Trim to max size
    if (this.recentAnomalies.length > this.maxRecentEvents) {
      this.recentAnomalies = this.recentAnomalies.slice(-this.maxRecentEvents);
    }
  }

  private startCorrelation(): void {
    this.correlationInterval = setInterval(() => {
      this.correlateAnomalies();
    }, this.correlationIntervalMs);
  }

  private correlateAnomalies(): void {
    try {
      // Get unresolved anomalies without correlation
      const uncorrelated = this.recentAnomalies.filter(a => !a.correlationId && !a.resolved);

      if (uncorrelated.length === 0) return;

      // Correlate them
      const newGroups = this.correlator.correlate(uncorrelated);

      if (newGroups.length > 0) {
        this.logger.log(`Correlated ${uncorrelated.length} anomalies into ${newGroups.length} pattern groups`);

        for (const group of newGroups) {
          this.logger.warn(
            `Pattern detected: ${group.pattern} (${group.severity}) - ${group.diagnosis}`
          );
        }

        this.recentGroups.push(...newGroups);

        // Trim groups
        if (this.recentGroups.length > this.maxRecentGroups) {
          this.recentGroups = this.recentGroups.slice(-this.maxRecentGroups);
        }
      }
    } catch (error) {
      this.logger.error('Failed to correlate anomalies:', error);
    }
  }

  // Public API methods

  getRecentEvents(limit = 100, metricType?: MetricType): AnomalyEvent[] {
    let events = [...this.recentAnomalies].reverse();

    if (metricType) {
      events = events.filter(e => e.metricType === metricType);
    }

    return events.slice(0, limit);
  }

  getRecentGroups(limit = 50, pattern?: AnomalyPattern): CorrelatedAnomalyGroup[] {
    let groups = [...this.recentGroups].reverse();

    if (pattern) {
      groups = groups.filter(g => g.pattern === pattern);
    }

    return groups.slice(0, limit);
  }

  getBufferStats(): BufferStats[] {
    const stats: BufferStats[] = [];

    for (const [metricType, buffer] of this.buffers.entries()) {
      stats.push(buffer.getStats());
    }

    return stats.sort((a, b) => a.metricType.localeCompare(b.metricType));
  }

  getSummary(): AnomalySummary {
    const activeEvents = this.recentAnomalies.filter(a => !a.resolved);
    const resolvedEvents = this.recentAnomalies.filter(a => a.resolved);

    const bySeverity: Record<AnomalySeverity, number> = {
      [AnomalySeverity.INFO]: 0,
      [AnomalySeverity.WARNING]: 0,
      [AnomalySeverity.CRITICAL]: 0,
    };

    const byMetric: Partial<Record<MetricType, number>> = {};
    const byPattern: Partial<Record<AnomalyPattern, number>> = {};

    for (const event of this.recentAnomalies) {
      bySeverity[event.severity]++;
      byMetric[event.metricType] = (byMetric[event.metricType] || 0) + 1;
    }

    for (const group of this.recentGroups) {
      byPattern[group.pattern] = (byPattern[group.pattern] || 0) + 1;
    }

    return {
      totalEvents: this.recentAnomalies.length,
      totalGroups: this.recentGroups.length,
      bySeverity,
      byMetric: byMetric as Record<MetricType, number>,
      byPattern: byPattern as Record<AnomalyPattern, number>,
      activeEvents: activeEvents.length,
      resolvedEvents: resolvedEvents.length,
    };
  }

  resolveAnomaly(anomalyId: string): boolean {
    const anomaly = this.recentAnomalies.find(a => a.id === anomalyId);
    if (anomaly) {
      anomaly.resolved = true;
      return true;
    }
    return false;
  }

  resolveGroup(correlationId: string): boolean {
    const group = this.recentGroups.find(g => g.correlationId === correlationId);
    if (group) {
      // Mark all anomalies in the group as resolved
      for (const anomaly of group.anomalies) {
        anomaly.resolved = true;
      }
      return true;
    }
    return false;
  }

  clearResolved(): number {
    const beforeCount = this.recentAnomalies.length;
    this.recentAnomalies = this.recentAnomalies.filter(a => !a.resolved);
    return beforeCount - this.recentAnomalies.length;
  }
}
