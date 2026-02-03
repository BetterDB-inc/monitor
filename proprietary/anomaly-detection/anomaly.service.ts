import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StoragePort, StoredAnomalyEvent, StoredCorrelatedGroup } from '@app/common/interfaces/storage-port.interface';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { SettingsService } from '@app/settings/settings.service';
import { MultiConnectionPoller, ConnectionContext } from '@app/common/services/multi-connection-poller';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { MetricBuffer } from './metric-buffer';
import { SpikeDetector } from './spike-detector';
import { Correlator } from './correlator';
import {
  MetricType,
  AnomalyEvent,
  CorrelatedAnomalyGroup,
  AnomalySeverity,
  AnomalyType,
  AnomalyPattern,
  BufferStats,
  AnomalySummary,
  SpikeDetectorConfig,
} from './types';

interface MetricExtractor {
  (info: Record<string, string>): number | null;
}

@Injectable()
export class AnomalyService extends MultiConnectionPoller implements OnModuleInit {
  protected readonly logger = new Logger(AnomalyService.name);

  // Per-connection state: connectionId -> metricType -> buffer/detector
  private buffers = new Map<string, Map<MetricType, MetricBuffer>>();
  private detectors = new Map<string, Map<MetricType, SpikeDetector>>();
  private correlator: Correlator;

  private recentAnomalies: AnomalyEvent[] = [];
  private recentGroups: CorrelatedAnomalyGroup[] = [];
  private readonly maxRecentEvents = 1000;
  private readonly maxRecentGroups = 100;

  private readonly metricExtractors: Map<MetricType, MetricExtractor>;
  private readonly correlationIntervalMs = 5000;
  private correlationInterval: NodeJS.Timeout | null = null;
  private prometheusSummaryInterval: NodeJS.Timeout | null = null;

  constructor(
    connectionRegistry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
    private readonly configService: ConfigService,
    private readonly prometheusService: PrometheusService,
    private readonly settingsService: SettingsService,
  ) {
    super(connectionRegistry);
    this.correlator = new Correlator(this.correlationIntervalMs);
    this.metricExtractors = this.initializeMetricExtractors();
  }

  protected getIntervalMs(): number {
    return this.settingsService.getCachedSettings().anomalyPollIntervalMs;
  }

  private get cacheTtlMs(): number {
    return this.settingsService.getCachedSettings().anomalyCacheTtlMs;
  }

  private get prometheusSummaryIntervalMs(): number {
    return this.settingsService.getCachedSettings().anomalyPrometheusIntervalMs;
  }

  onModuleInit() {
    this.logger.log('Starting anomaly detection service...');

    // Start multi-connection polling
    this.start();

    // Start correlation loop
    this.correlationInterval = setInterval(() => {
      this.correlateAnomalies().catch(err => {
        this.logger.error('Failed to correlate anomalies:', err);
      });
    }, this.correlationIntervalMs);

    // Start prometheus summary loop
    this.prometheusSummaryInterval = setInterval(() => {
      this.updatePrometheusSummary().catch(err => {
        this.logger.error('Failed to update prometheus summary:', err);
      });
    }, this.prometheusSummaryIntervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    await super.onModuleDestroy();
    if (this.correlationInterval) {
      clearInterval(this.correlationInterval);
      this.correlationInterval = null;
    }
    if (this.prometheusSummaryInterval) {
      clearInterval(this.prometheusSummaryInterval);
      this.prometheusSummaryInterval = null;
    }
  }

  private getOrCreateBuffersAndDetectors(connectionId: string): {
    buffers: Map<MetricType, MetricBuffer>;
    detectors: Map<MetricType, SpikeDetector>;
  } {
    if (!this.buffers.has(connectionId)) {
      this.initializeBuffersAndDetectorsForConnection(connectionId);
    }
    return {
      buffers: this.buffers.get(connectionId)!,
      detectors: this.detectors.get(connectionId)!,
    };
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

  private initializeBuffersAndDetectorsForConnection(connectionId: string): void {
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
    const connectionBuffers = new Map<MetricType, MetricBuffer>();
    const connectionDetectors = new Map<MetricType, SpikeDetector>();

    for (const metricType of Object.values(MetricType)) {
      connectionBuffers.set(metricType, new MetricBuffer(metricType));
      const config = configs[metricType] || {};
      connectionDetectors.set(metricType, new SpikeDetector(metricType, config));
    }

    this.buffers.set(connectionId, connectionBuffers);
    this.detectors.set(connectionId, connectionDetectors);
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.buffers.delete(connectionId);
    this.detectors.delete(connectionId);
    this.logger.debug(`Cleaned up anomaly detection state for connection ${connectionId}`);
  }

  private parseNumber(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    try {
      const infoResponse = await ctx.client.getInfoParsed();
      const info = this.convertInfoToRecord(infoResponse);
      const timestamp = Date.now();

      const { buffers, detectors } = this.getOrCreateBuffersAndDetectors(ctx.connectionId);

      // Process each metric
      for (const [metricType, extractor] of this.metricExtractors.entries()) {
        const value = extractor(info);
        if (value === null) continue;

        const buffer = buffers.get(metricType);
        const detector = detectors.get(metricType);

        if (!buffer || !detector) continue;

        // Add sample to buffer
        buffer.addSample(value, timestamp);

        // Run detection
        const anomaly = detector.detect(buffer, value, timestamp);
        if (anomaly) {
          // Enrich anomaly with connection context
          anomaly.connectionId = ctx.connectionId;
          this.logger.warn(`Anomaly detected for ${ctx.connectionName}: ${anomaly.message}`);
          await this.addAnomaly(anomaly, ctx);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to poll metrics for ${ctx.connectionName}:`, error);
      throw error;
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

  private toStoredAnomalyEvent(anomaly: AnomalyEvent, ctx?: ConnectionContext): StoredAnomalyEvent {
    return {
      id: anomaly.id,
      timestamp: anomaly.timestamp,
      metricType: anomaly.metricType,
      anomalyType: anomaly.anomalyType,
      severity: anomaly.severity,
      value: anomaly.value,
      baseline: anomaly.baseline,
      stdDev: anomaly.stdDev,
      zScore: anomaly.zScore,
      threshold: anomaly.threshold,
      message: anomaly.message,
      correlationId: anomaly.correlationId,
      relatedMetrics: anomaly.relatedMetrics,
      resolved: anomaly.resolved || false,
      resolvedAt: undefined,
      durationMs: undefined,
      sourceHost: ctx?.host || this.configService.get('database.host'),
      sourcePort: ctx?.port || this.configService.get('database.port'),
      connectionId: ctx?.connectionId || anomaly.connectionId,
    };
  }

  private async addAnomaly(anomaly: AnomalyEvent, ctx?: ConnectionContext): Promise<void> {
    this.recentAnomalies.push(anomaly);

    if (this.recentAnomalies.length > this.maxRecentEvents) {
      this.recentAnomalies = this.recentAnomalies.slice(-this.maxRecentEvents);
    }

    this.prometheusService.incrementAnomalyEvent(anomaly.severity, anomaly.metricType, anomaly.anomalyType, ctx?.connectionId);

    try {
      const connectionId = ctx?.connectionId || anomaly.connectionId;
      if (connectionId) {
        await this.storage.saveAnomalyEvent(this.toStoredAnomalyEvent(anomaly, ctx), connectionId);
      }
    } catch (err) {
      this.logger.error('Failed to persist anomaly event:', err);
    }
  }

  private async correlateAnomalies(): Promise<void> {
    try {
      const uncorrelated = this.recentAnomalies.filter(a => !a.correlationId && !a.resolved);
      if (uncorrelated.length === 0) return;

      const newGroups = this.correlator.correlate(uncorrelated);
      if (newGroups.length === 0) return;

      this.logger.log(`Correlated ${uncorrelated.length} anomalies into ${newGroups.length} pattern groups`);

      for (const group of newGroups) {
        this.logger.warn(
          `Pattern detected: ${group.pattern} (${group.severity}) - ${group.diagnosis}`
        );

        // Get connectionId from first anomaly in group (all should have same connectionId)
        const groupConnectionId = group.anomalies[0]?.connectionId;
        this.prometheusService.incrementCorrelatedGroup(group.pattern, group.severity, groupConnectionId);

        const storedGroup: StoredCorrelatedGroup = {
          correlationId: group.correlationId,
          timestamp: group.timestamp,
          pattern: group.pattern,
          severity: group.severity,
          diagnosis: group.diagnosis,
          recommendations: group.recommendations,
          anomalyCount: group.anomalies.length,
          metricTypes: group.anomalies.map(a => a.metricType),
          sourceHost: this.configService.get('database.host'),
          sourcePort: this.configService.get('database.port'),
        };

        try {
          // Get connectionId from first anomaly in group (all should have same connectionId)
          const connectionId = group.anomalies[0]?.connectionId;
          if (connectionId) {
            await this.storage.saveCorrelatedGroup(storedGroup, connectionId);
            for (const anomaly of group.anomalies) {
              await this.storage.saveAnomalyEvent(this.toStoredAnomalyEvent(anomaly), connectionId);
            }
          }
        } catch (err) {
          this.logger.error('Failed to persist correlated group:', err);
        }
      }

      this.recentGroups.push(...newGroups);
      if (this.recentGroups.length > this.maxRecentGroups) {
        this.recentGroups = this.recentGroups.slice(-this.maxRecentGroups);
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

  private storedToAnomalyEvent(s: StoredAnomalyEvent): AnomalyEvent {
    return {
      id: s.id,
      timestamp: s.timestamp,
      metricType: s.metricType as MetricType,
      anomalyType: s.anomalyType === 'spike' ? AnomalyType.SPIKE : AnomalyType.DROP,
      severity: s.severity as AnomalySeverity,
      value: s.value,
      baseline: s.baseline,
      stdDev: s.stdDev,
      zScore: s.zScore,
      threshold: s.threshold,
      message: s.message,
      correlationId: s.correlationId,
      relatedMetrics: s.relatedMetrics as MetricType[],
      resolved: s.resolved,
    };
  }

  async getRecentAnomalies(
    startTime?: number,
    endTime?: number,
    severity?: AnomalySeverity,
    metricType?: MetricType,
    limit = 100,
    connectionId?: string,
  ): Promise<AnomalyEvent[]> {
    const cacheThreshold = Date.now() - this.cacheTtlMs;

    if (!startTime || startTime >= cacheThreshold) {
      let events = [...this.recentAnomalies];
      if (connectionId) events = events.filter(e => e.connectionId === connectionId);
      if (metricType) events = events.filter(e => e.metricType === metricType);
      if (severity) events = events.filter(e => e.severity === severity);
      if (endTime) events = events.filter(e => e.timestamp <= endTime);
      return events.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }

    const stored = await this.storage.getAnomalyEvents({
      startTime,
      endTime,
      severity: severity as string,
      metricType: metricType as string,
      limit,
      connectionId,
    });

    return stored.map(s => this.storedToAnomalyEvent(s));
  }

  getRecentGroups(limit = 50, pattern?: AnomalyPattern): CorrelatedAnomalyGroup[] {
    let groups = [...this.recentGroups].reverse();

    if (pattern) {
      groups = groups.filter(g => g.pattern === pattern);
    }

    return groups.slice(0, limit);
  }

  async getRecentCorrelatedGroups(
    startTime?: number,
    endTime?: number,
    pattern?: AnomalyPattern,
    limit = 50,
    connectionId?: string,
  ): Promise<CorrelatedAnomalyGroup[]> {
    const cacheThreshold = Date.now() - this.cacheTtlMs;

    if (!startTime || startTime >= cacheThreshold) {
      let groups = [...this.recentGroups];
      if (connectionId) groups = groups.filter(g => g.anomalies.some(a => a.connectionId === connectionId));
      if (pattern) groups = groups.filter(g => g.pattern === pattern);
      if (endTime) groups = groups.filter(g => g.timestamp <= endTime);
      return groups.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }

    const stored = await this.storage.getCorrelatedGroups({
      startTime,
      endTime,
      pattern: pattern as string,
      limit,
      connectionId,
    });

    const groups: CorrelatedAnomalyGroup[] = [];
    for (const s of stored) {
      const storedAnomalies = await this.storage.getAnomalyEvents({
        startTime: s.timestamp - this.correlationIntervalMs,
        endTime: s.timestamp + this.correlationIntervalMs,
        connectionId,
      });
      const anomalies = storedAnomalies
        .filter(a => a.correlationId === s.correlationId)
        .map(a => this.storedToAnomalyEvent(a));

      groups.push({
        correlationId: s.correlationId,
        timestamp: s.timestamp,
        pattern: s.pattern as AnomalyPattern,
        severity: s.severity as AnomalySeverity,
        diagnosis: s.diagnosis,
        recommendations: s.recommendations,
        anomalies,
      });
    }

    return groups;
  }

  getBufferStats(connectionId?: string): BufferStats[] {
    const stats: BufferStats[] = [];

    // Iterate over all connections and their buffers
    for (const [connId, connectionBuffers] of this.buffers.entries()) {
      // Filter by connectionId if provided
      if (connectionId && connId !== connectionId) continue;

      for (const [, buffer] of connectionBuffers.entries()) {
        const bufferStats = buffer.getStats();
        stats.push({
          ...bufferStats,
          connectionId: connId,
        });
      }
    }

    // Sort by connectionId then metricType
    return stats.sort((a, b) => {
      const connCmp = (a.connectionId || '').localeCompare(b.connectionId || '');
      if (connCmp !== 0) return connCmp;
      return a.metricType.localeCompare(b.metricType);
    });
  }

  getWarmupStatus(): { isReady: boolean; buffersReady: number; buffersTotal: number; warmupProgress: number } {
    const stats = this.getBufferStats();
    const buffersTotal = stats.length;
    const buffersReady = stats.filter(s => s.isReady).length;

    return {
      isReady: buffersReady === buffersTotal,
      buffersReady,
      buffersTotal,
      warmupProgress: buffersTotal > 0 ? Math.round((buffersReady / buffersTotal) * 100) : 100,
    };
  }

  async getSummary(startTime?: number, endTime?: number, connectionId?: string): Promise<AnomalySummary> {
    const cacheThreshold = Date.now() - this.cacheTtlMs;

    // Use in-memory data if no start time or start time is within cache TTL
    if (!startTime || startTime >= cacheThreshold) {
      let events = [...this.recentAnomalies];
      let groups = [...this.recentGroups];

      if (connectionId) {
        events = events.filter(e => e.connectionId === connectionId);
        groups = groups.filter(g => g.anomalies.some(a => a.connectionId === connectionId));
      }

      if (endTime) {
        events = events.filter(e => e.timestamp <= endTime);
        groups = groups.filter(g => g.timestamp <= endTime);
      }

      const activeEvents = events.filter(a => !a.resolved);
      const resolvedEvents = events.filter(a => a.resolved);

      const bySeverity: Record<AnomalySeverity, number> = {
        [AnomalySeverity.INFO]: 0,
        [AnomalySeverity.WARNING]: 0,
        [AnomalySeverity.CRITICAL]: 0,
      };

      const byMetric: Partial<Record<MetricType, number>> = {};
      const byPattern: Partial<Record<AnomalyPattern, number>> = {};

      for (const event of events) {
        bySeverity[event.severity]++;
        byMetric[event.metricType] = (byMetric[event.metricType] || 0) + 1;
      }

      for (const group of groups) {
        byPattern[group.pattern] = (byPattern[group.pattern] || 0) + 1;
      }

      return {
        totalEvents: events.length,
        totalGroups: groups.length,
        bySeverity,
        byMetric: byMetric as Record<MetricType, number>,
        byPattern: byPattern as Record<AnomalyPattern, number>,
        activeEvents: activeEvents.length,
        resolvedEvents: resolvedEvents.length,
      };
    }

    // Query historical data from storage
    const storedEvents = await this.storage.getAnomalyEvents({
      startTime,
      endTime,
    });

    const storedGroups = await this.storage.getCorrelatedGroups({
      startTime,
      endTime,
    });

    const events = storedEvents.map(s => this.storedToAnomalyEvent(s));
    const activeEvents = events.filter(a => !a.resolved);
    const resolvedEvents = events.filter(a => a.resolved);

    const bySeverity: Record<AnomalySeverity, number> = {
      [AnomalySeverity.INFO]: 0,
      [AnomalySeverity.WARNING]: 0,
      [AnomalySeverity.CRITICAL]: 0,
    };

    const byMetric: Partial<Record<MetricType, number>> = {};
    const byPattern: Partial<Record<AnomalyPattern, number>> = {};

    for (const event of events) {
      bySeverity[event.severity]++;
      byMetric[event.metricType] = (byMetric[event.metricType] || 0) + 1;
    }

    for (const group of storedGroups) {
      const pattern = group.pattern as AnomalyPattern;
      byPattern[pattern] = (byPattern[pattern] || 0) + 1;
    }

    return {
      totalEvents: events.length,
      totalGroups: storedGroups.length,
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

  private async updatePrometheusSummary(): Promise<void> {
    const oneHourAgo = Date.now() - 3600000;
    const bySeverity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    const byMetric: Record<string, number> = {};
    const unresolvedBySeverity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    const byPattern: Record<string, number> = {};

    for (const a of this.recentAnomalies) {
      if (a.timestamp < oneHourAgo) continue;
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      byMetric[a.metricType] = (byMetric[a.metricType] ?? 0) + 1;
      if (!a.resolved) unresolvedBySeverity[a.severity] = (unresolvedBySeverity[a.severity] ?? 0) + 1;
    }

    for (const g of this.recentGroups) {
      if (g.timestamp >= oneHourAgo) byPattern[g.pattern] = (byPattern[g.pattern] ?? 0) + 1;
    }

    this.prometheusService.updateAnomalySummary({ bySeverity, byMetric, byPattern, unresolvedBySeverity });

    const bufferStats = this.getBufferStats().map(s => ({
      metricType: s.metricType, mean: s.mean, stdDev: s.stdDev, ready: s.isReady,
    }));
    this.prometheusService.updateAnomalyBufferStats(bufferStats);
  }
}
