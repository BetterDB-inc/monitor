import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AnomalyService } from '../anomaly.service';
import { MetricsParser } from '@app/database/parsers/metrics.parser';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { SettingsService } from '@app/settings/settings.service';
import { SlowLogAnalyticsService } from '@app/slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '@app/commandlog-analytics/commandlog-analytics.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ConnectionContext } from '@app/common/services/multi-connection-poller';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';
import { ClusterNode } from '@app/common/types/metrics.types';
import {
  MetricType,
  METRICS_HANDLED_OUTSIDE_EXTRACTOR,
  AnomalySeverity,
  AnomalyType,
} from '../types';
import { WEBHOOK_EVENTS_PRO_SERVICE, WebhookEventType } from '@betterdb/shared';
import { OtelEventDispatcherService } from '@app/otel-telemetry/otel-event-dispatcher.service';

describe('AnomalyService', () => {
  let service: AnomalyService;
  let slowLogAnalytics: { getLastSeenId: jest.Mock };
  let commandLogAnalytics: { getCachedEntries: jest.Mock };
  let storage: Record<string, jest.Mock>;
  let prometheusService: Record<string, jest.Mock>;
  let webhookEventsProService: Record<string, jest.Mock>;
  let otelEvents: { dispatch: jest.Mock };
  let dbClient: jest.Mocked<Partial<DatabasePort>>;
  let mockCtx: ConnectionContext;

  beforeEach(async () => {
    slowLogAnalytics = {
      getLastSeenId: jest.fn().mockReturnValue(null),
    };

    commandLogAnalytics = {
      getCachedEntries: jest.fn().mockReturnValue([]),
    };

    storage = {
      saveAnomalyEvent: jest.fn().mockResolvedValue(undefined),
      saveCorrelatedGroup: jest.fn().mockResolvedValue(undefined),
      getAnomalyEvents: jest.fn().mockResolvedValue([]),
      getCorrelatedGroups: jest.fn().mockResolvedValue([]),
      resolveAnomaly: jest.fn().mockResolvedValue(true),
      getAclEntries: jest.fn().mockResolvedValue([]),
      initialize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      isReady: jest.fn().mockReturnValue(true),
    };

    prometheusService = {
      incrementAnomalyEvent: jest.fn(),
      incrementCorrelatedGroup: jest.fn(),
      updateAnomalySummary: jest.fn(),
      updateAnomalyBufferStats: jest.fn(),
      updateReplBufferPressure: jest.fn(),
    };

    webhookEventsProService = {
      isEnabled: jest.fn().mockReturnValue(true),
      dispatchFailoverStarted: jest.fn().mockResolvedValue(undefined),
      dispatchFailoverCompleted: jest.fn().mockResolvedValue(undefined),
      dispatchClusterFailover: jest.fn().mockResolvedValue(undefined),
      dispatchAnomalyDetected: jest.fn().mockResolvedValue(undefined),
      dispatchSlowlogThreshold: jest.fn().mockResolvedValue(undefined),
      dispatchReplicationLag: jest.fn().mockResolvedValue(undefined),
      dispatchLatencySpike: jest.fn().mockResolvedValue(undefined),
      dispatchConnectionSpike: jest.fn().mockResolvedValue(undefined),
      dispatchMetricForecastLimit: jest.fn().mockResolvedValue(undefined),
      dispatchDataLossDetected: jest.fn().mockResolvedValue(undefined),
    };

    otelEvents = { dispatch: jest.fn() };

    dbClient = {
      getInfoParsed: jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: {
          used_memory: '1000000',
          allocator_frag_ratio: '1.1',
          mem_fragmentation_ratio: '1.5',
        },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      }),
    };

    mockCtx = {
      connectionId: 'conn-1',
      connectionName: 'Test Connection',
      client: dbClient as any,
      host: 'localhost',
      port: 6379,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnomalyService,
        {
          provide: ConnectionRegistry,
          useValue: {
            list: jest.fn().mockReturnValue([]),
            get: jest.fn(),
          },
        },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        {
          provide: ConfigService,
          useValue: {
            // The Zod env schema validates these to numbers before they reach
            // the service, so the mock returns the schema defaults for them and
            // falls back to 'localhost' for any other key.
            get: jest.fn((key: string) => {
              const numeric: Record<string, number> = {
                MONITOR_PERSISTENCE_STALL_SEC: 60,
                MONITOR_PERSISTENCE_WARN_SEC: 120,
                MONITOR_PERSISTENCE_CRIT_SEC: 600,
              };
              return key in numeric ? numeric[key] : 'localhost';
            }),
          },
        },
        { provide: PrometheusService, useValue: prometheusService },
        {
          provide: SettingsService,
          useValue: {
            getCachedSettings: jest.fn().mockReturnValue({
              anomalyPollIntervalMs: 1000,
              anomalyCacheTtlMs: 300000,
              anomalyPrometheusIntervalMs: 30000,
            }),
          },
        },
        { provide: SlowLogAnalyticsService, useValue: slowLogAnalytics },
        { provide: CommandLogAnalyticsService, useValue: commandLogAnalytics },
        { provide: WEBHOOK_EVENTS_PRO_SERVICE, useValue: webhookEventsProService },
        { provide: OtelEventDispatcherService, useValue: otelEvents },
      ],
    }).compile();

    service = module.get<AnomalyService>(AnomalyService);
    // Do NOT call onModuleInit() — avoids real timers
  });

  /** Helper to invoke the protected pollConnection via cast */
  async function poll(ctx: ConnectionContext = mockCtx): Promise<void> {
    await (service as any).pollConnection(ctx);
  }

  // ─── getRecentAnomalies cache fall-through ─────────────────────────────────

  describe('getRecentAnomalies cache fall-through', () => {
    it('consults storage when the cache has no match for a recent window', async () => {
      const storedEvent = {
        id: 'e1',
        timestamp: Date.now() - 60_000,
        metricType: 'command_p99',
        anomalyType: 'spike',
        severity: 'warning',
        value: 200,
        baseline: 100,
        zScore: 0,
        stdDev: 0,
        threshold: 2,
        message: 'p99 regression',
        resolved: false,
        connectionId: 'c1',
      };
      storage.getAnomalyEvents.mockResolvedValueOnce([storedEvent]);
      const events = await service.getRecentAnomalies(
        Date.now() - 120_000,
        undefined,
        undefined,
        MetricType.COMMAND_P99,
        10,
        'c1',
      );
      expect(events).toHaveLength(1);
      expect(storage.getAnomalyEvents).toHaveBeenCalledWith(
        expect.objectContaining({ metricType: 'command_p99', connectionId: 'c1' }),
      );
    });

    it('unions storage-only events with cached events on unfiltered recent reads', async () => {
      const storedEvent = {
        id: 'stored-1',
        timestamp: Date.now() - 30_000,
        metricType: 'command_p99',
        anomalyType: 'spike',
        severity: 'warning',
        value: 200,
        baseline: 100,
        zScore: 0,
        stdDev: 0,
        threshold: 2,
        message: 'p99 regression',
        resolved: false,
        connectionId: 'c1',
      };
      storage.getAnomalyEvents.mockResolvedValueOnce([storedEvent]);
      (service as any).recentAnomalies.push({
        id: 'cached-1',
        timestamp: Date.now() - 10_000,
        metricType: MetricType.MEMORY_USED,
        anomalyType: AnomalyType.SPIKE,
        severity: AnomalySeverity.WARNING,
        value: 1,
        baseline: 1,
        zScore: 3,
        stdDev: 1,
        threshold: 3,
        message: 'memory spike',
        resolved: false,
        connectionId: 'c1',
      });
      const events = await service.getRecentAnomalies(
        undefined,
        undefined,
        undefined,
        undefined,
        10,
        'c1',
      );
      const ids = events.map((e) => e.id);
      expect(ids).toContain('stored-1');
      expect(ids).toContain('cached-1');
      const storedMapped = events.find((e) => e.id === 'stored-1');
      expect(storedMapped?.connectionId).toBe('c1');
    });
  });

  // ─── Fragmentation Extractor ───────────────────────────────────────────────

  describe('fragmentation extractor', () => {
    it('prefers allocator_frag_ratio over mem_fragmentation_ratio', async () => {
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const fragBuffer = buffers.get(MetricType.FRAGMENTATION_RATIO);
      expect(fragBuffer.getLatest()).toBe(1.1); // allocator_frag_ratio
    });

    it('falls back to mem_fragmentation_ratio when allocator_frag_ratio absent', async () => {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: {
          used_memory: '1000000',
          mem_fragmentation_ratio: '1.5',
        },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });

      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const fragBuffer = buffers.get(MetricType.FRAGMENTATION_RATIO);
      expect(fragBuffer.getLatest()).toBe(1.5);
    });

    it('falls back to mem_fragmentation_ratio when allocator_frag_ratio is empty string', async () => {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: {
          used_memory: '1000000',
          allocator_frag_ratio: '',
          mem_fragmentation_ratio: '1.5',
        },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });

      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const fragBuffer = buffers.get(MetricType.FRAGMENTATION_RATIO);
      expect(fragBuffer.getLatest()).toBe(1.5);
    });

    it('falls back to mem_fragmentation_ratio when allocator_frag_ratio is non-numeric', async () => {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: {
          used_memory: '1000000',
          allocator_frag_ratio: 'nan',
          mem_fragmentation_ratio: '1.8',
        },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });

      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const fragBuffer = buffers.get(MetricType.FRAGMENTATION_RATIO);
      expect(fragBuffer.getLatest()).toBe(1.8);
    });

    it('skips NaN/non-numeric values via parseNumber', async () => {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: {
          used_memory: '1000000',
          allocator_frag_ratio: 'not-a-number',
          mem_fragmentation_ratio: 'NaN',
        },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });

      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const fragBuffer = buffers.get(MetricType.FRAGMENTATION_RATIO);
      // Value should not have been added (extractor returns null for NaN)
      expect(fragBuffer.getSampleCount()).toBe(0);
    });
  });

  // ─── Slowlog Delta from SlowLogAnalyticsService ─────────────────────────

  describe('slowlog delta detection', () => {
    it('does not create buffer when getLastSeenId returns null', async () => {
      slowLogAnalytics.getLastSeenId.mockReturnValue(null);
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.SLOWLOG_LAST_ID)).toBe(false);
    });

    it('lazily creates buffer on first non-null data', async () => {
      slowLogAnalytics.getLastSeenId.mockReturnValue(100);
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.SLOWLOG_LAST_ID)).toBe(true);
    });

    it('records delta=0 on first sample', async () => {
      slowLogAnalytics.getLastSeenId.mockReturnValue(100);
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const buf = buffers.get(MetricType.SLOWLOG_LAST_ID);
      expect(buf.getLatest()).toBe(0); // delta = 100 - 100 = 0
    });

    it('computes correct delta between consecutive polls', async () => {
      slowLogAnalytics.getLastSeenId.mockReturnValue(100);
      await poll();
      slowLogAnalytics.getLastSeenId.mockReturnValue(105);
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const buf = buffers.get(MetricType.SLOWLOG_LAST_ID);
      expect(buf.getLatest()).toBe(5); // 105 - 100
    });

    it('clamps negative delta to 0 (e.g. server restart / SLOWLOG RESET)', async () => {
      slowLogAnalytics.getLastSeenId.mockReturnValue(100);
      await poll();
      slowLogAnalytics.getLastSeenId.mockReturnValue(50); // lower than before
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const buf = buffers.get(MetricType.SLOWLOG_LAST_ID);
      expect(buf.getLatest()).toBe(0); // clamped via Math.max(0, ...)
    });

    it('uses a low-threshold spike detector config for SLOWLOG_LAST_ID', async () => {
      slowLogAnalytics.getLastSeenId.mockReturnValue(100);
      await poll();
      const config = (service as any).detectors
        .get('conn-1')
        .get(MetricType.SLOWLOG_LAST_ID)
        .getConfig();
      expect(config.consecutiveRequired).toBe(1);
      expect(config.cooldownMs).toBeLessThanOrEqual(30000);
    });

    it('calls getLastSeenId with the correct connectionId', async () => {
      await poll();
      expect(slowLogAnalytics.getLastSeenId).toHaveBeenCalledWith('conn-1');
    });
  });

  // ─── Replication Role State-Change Detection ────────────────────────────

  describe('replication role state-change', () => {
    it('does not fire anomaly on first poll (no baseline)', async () => {
      await poll();
      const events = service.getRecentEvents();
      const failoverEvents = events.filter((e) => e.metricType === MetricType.REPLICATION_ROLE);
      expect(failoverEvents).toHaveLength(0);
    });

    it('does not fire anomaly when role remains master', async () => {
      await poll(); // sets baseline to master
      await poll(); // still master
      const events = service.getRecentEvents();
      const failoverEvents = events.filter((e) => e.metricType === MetricType.REPLICATION_ROLE);
      expect(failoverEvents).toHaveLength(0);
    });

    it('does not fire anomaly when role remains replica', async () => {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'replica' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();
      await poll();
      const events = service.getRecentEvents();
      const failoverEvents = events.filter((e) => e.metricType === MetricType.REPLICATION_ROLE);
      expect(failoverEvents).toHaveLength(0);
    });

    it('fires CRITICAL anomaly on master→replica transition', async () => {
      // First poll: master
      await poll();

      // Second poll: replica
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'replica' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();

      const events = service.getRecentEvents();
      const failoverEvents = events.filter((e) => e.metricType === MetricType.REPLICATION_ROLE);
      expect(failoverEvents).toHaveLength(1);
      expect(failoverEvents[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(failoverEvents[0].anomalyType).toBe(AnomalyType.DROP);
      expect(failoverEvents[0].message).toContain('master to replica');
    });

    it('detects master→slave (legacy naming)', async () => {
      await poll(); // master

      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'slave' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();

      const events = service.getRecentEvents();
      const failoverEvents = events.filter((e) => e.metricType === MetricType.REPLICATION_ROLE);
      expect(failoverEvents).toHaveLength(1);
      expect(failoverEvents[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('fires WARNING anomaly on replica→master promotion', async () => {
      // First poll: replica
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'replica' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();

      // Second poll: master (promotion)
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();

      const events = service.getRecentEvents();
      const failoverEvents = events.filter((e) => e.metricType === MetricType.REPLICATION_ROLE);
      expect(failoverEvents).toHaveLength(1);
      expect(failoverEvents[0].severity).toBe(AnomalySeverity.WARNING);
      expect(failoverEvents[0].anomalyType).toBe(AnomalyType.SPIKE);
      expect(failoverEvents[0].message).toContain('promoted from replica to master');
    });

    it('ignores unknown roles (e.g. sentinel)', async () => {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'sentinel' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();
      await poll();

      const lastRole = (service as any).lastReplicationRole.get('conn-1');
      expect(lastRole).toBeUndefined();
    });

    it('dispatches failover.started webhook on master→replica demotion', async () => {
      // First poll: master
      await poll();

      // Second poll: replica
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'replica' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();

      expect(webhookEventsProService.dispatchFailoverStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          previousRole: 'master',
          newRole: 'replica',
          connectionId: 'conn-1',
        }),
      );
    });

    it('dispatches failover.completed webhook on replica→master promotion', async () => {
      // First poll: replica
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'replica' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();

      // Second poll: master (promotion)
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
      });
      await poll();

      expect(webhookEventsProService.dispatchFailoverCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          previousRole: 'replica',
          newRole: 'master',
          connectionId: 'conn-1',
        }),
      );
    });
  });

  // ─── CPU Utilization Delta Detection ─────────────────────────────────────

  describe('CPU utilization delta detection', () => {
    function mockInfoWithCpu(cpuSys: string, cpuUser: string) {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
        cpu: { used_cpu_sys: cpuSys, used_cpu_user: cpuUser },
      });
    }

    it('does not record a sample on the first poll (no previous baseline)', async () => {
      mockInfoWithCpu('10.0', '20.0');
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const cpuBuffer = buffers.get(MetricType.CPU_UTILIZATION);
      expect(cpuBuffer.getSampleCount()).toBe(0);
    });

    it('records utilization delta on second poll', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);

      mockInfoWithCpu('10.0', '20.0');
      await poll();
      mockInfoWithCpu('10.5', '20.5');
      await poll();

      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const cpuBuffer = buffers.get(MetricType.CPU_UTILIZATION);
      expect(cpuBuffer.getSampleCount()).toBe(1);
      // (10.5 + 20.5 - 10.0 - 20.0) / (1s) * 100 = 100
      expect(cpuBuffer.getLatest()).toBe(100);
    });

    it('skips sample when utilization is negative (counter reset)', async () => {
      jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(2000);

      mockInfoWithCpu('50.0', '50.0');
      await poll();
      mockInfoWithCpu('1.0', '1.0'); // server restarted, counters reset
      await poll();

      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const cpuBuffer = buffers.get(MetricType.CPU_UTILIZATION);
      expect(cpuBuffer.getSampleCount()).toBe(0);
    });

    it('skips when cpu fields are missing from INFO', async () => {
      // Default mock has no cpu section
      await poll();
      await poll();
      const prevCpu = (service as any).prevCpuByConnection.get('conn-1');
      expect(prevCpu).toBeUndefined();
    });

    it('cleans up prevCpuByConnection on connection removal', async () => {
      mockInfoWithCpu('10.0', '20.0');
      await poll();
      expect((service as any).prevCpuByConnection.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');
      expect((service as any).prevCpuByConnection.has('conn-1')).toBe(false);
    });

    it('initializes CPU buffer and detector during buffer init', async () => {
      await poll(); // triggers buffer initialization
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const detectors: Map<MetricType, any> = (service as any).detectors.get('conn-1');
      expect(buffers.has(MetricType.CPU_UTILIZATION)).toBe(true);
      expect(detectors.has(MetricType.CPU_UTILIZATION)).toBe(true);
    });

    it('CPU detector has detectDrops enabled', async () => {
      await poll();
      const detectors: Map<MetricType, any> = (service as any).detectors.get('conn-1');
      const config = detectors.get(MetricType.CPU_UTILIZATION).getConfig();
      expect(config.detectDrops).toBe(true);
    });
  });

  // ─── Buffer Initialization ──────────────────────────────────────────────

  describe('buffer initialization', () => {
    it('excludes REPLICATION_ROLE from initial buffer loop', async () => {
      await poll(); // triggers getOrCreateBuffersAndDetectors
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.REPLICATION_ROLE)).toBe(false);
    });

    it('excludes CLUSTER_STATE from initial buffer loop', async () => {
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.CLUSTER_STATE)).toBe(false);
    });

    it('excludes CLUSTER_TOPOLOGY from initial buffer loop', async () => {
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.CLUSTER_TOPOLOGY)).toBe(false);
    });

    it('excludes REPLICA_SLOT_STATE from initial buffer loop', async () => {
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.REPLICA_SLOT_STATE)).toBe(false);
    });

    it('excludes SLOWLOG_LAST_ID from initial buffer loop', async () => {
      await poll();
      // Without slowlog data, SLOWLOG_LAST_ID should not be present
      slowLogAnalytics.getLastSeenId.mockReturnValue(null);
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.SLOWLOG_LAST_ID)).toBe(false);
    });

    it('creates buffers for all other metric types', async () => {
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      const expectedMetrics = Object.values(MetricType).filter(
        (m) => !METRICS_HANDLED_OUTSIDE_EXTRACTOR.has(m),
      );
      for (const metric of expectedMetrics) {
        expect(buffers.has(metric)).toBe(true);
      }
    });
  });

  // ─── Connection Cleanup ─────────────────────────────────────────────────

  describe('connection cleanup (onConnectionRemoved)', () => {
    it('clears lastSlowlogId, lastReplicationRole, and lastClusterState maps', async () => {
      slowLogAnalytics.getLastSeenId.mockReturnValue(100);
      await poll(); // populates state

      expect((service as any).lastSlowlogId.has('conn-1')).toBe(true);
      expect((service as any).lastReplicationRole.has('conn-1')).toBe(true);

      // Call onConnectionRemoved
      (service as any).onConnectionRemoved('conn-1');

      expect((service as any).lastSlowlogId.has('conn-1')).toBe(false);
      expect((service as any).lastReplicationRole.has('conn-1')).toBe(false);
      expect((service as any).lastClusterState.has('conn-1')).toBe(false);
      expect((service as any).buffers.has('conn-1')).toBe(false);
      expect((service as any).detectors.has('conn-1')).toBe(false);
    });

    it('clears large-reply pressure state maps', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('8192');
      commandLogAnalytics.getCachedEntries.mockReturnValue([
        {
          id: 1,
          timestamp: 1000,
          duration: 20000,
          command: ['GET', 'k'],
          clientAddress: '',
          clientName: '',
          type: 'large-reply',
        },
      ]);
      await poll(); // populates state

      expect((service as any).activeLargeReplyOffenders.has('conn-1')).toBe(true);
      expect((service as any).largeReplyThresholdCache.has('conn-1')).toBe(true);
      expect((service as any).largeReplyThresholdRecheck.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');

      expect((service as any).activeLargeReplyOffenders.has('conn-1')).toBe(false);
      expect((service as any).largeReplyThresholdCache.has('conn-1')).toBe(false);
      expect((service as any).largeReplyThresholdRecheck.has('conn-1')).toBe(false);
    });
  });

  // ─── Large-Reply Commandlog Pressure (valkey#2926) ──────────────────────

  describe('large-reply commandlog pressure', () => {
    function largeReplyEntry(command: string[], duration: number, id = 1, timestamp = 1000) {
      return {
        id,
        timestamp,
        duration,
        command,
        clientAddress: '127.0.0.1:1234',
        clientName: '',
        type: 'large-reply' as const,
      };
    }

    function eventsOf(metricType: MetricType) {
      return service.getRecentEvents().filter((e) => e.metricType === metricType);
    }

    it('does nothing and never calls CONFIG GET when the cache is empty', async () => {
      commandLogAnalytics.getCachedEntries.mockReturnValue([]);
      dbClient.getConfigValue = jest.fn().mockResolvedValue('8192');
      await poll();
      expect(dbClient.getConfigValue).not.toHaveBeenCalled();
      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(0);
    });

    it('emits a WARNING once a command crosses the threshold enough times', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('8192');
      const entries = Array.from({ length: 5 }, (_, i) =>
        largeReplyEntry(['GET', `k${i}`], 20000, i + 1),
      );
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);

      await poll();

      expect(dbClient.getConfigValue).toHaveBeenCalledWith('commandlog-reply-larger-than');
      const events = eventsOf(MetricType.LARGE_REPLY_PRESSURE);
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('GET');
      expect(events[0].message).toContain('valkey#2926');
    });

    it('does not re-emit on a subsequent poll for the same offending command (dedupe)', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('8192');
      const entries = Array.from({ length: 5 }, (_, i) =>
        largeReplyEntry(['GET', `k${i}`], 20000, i + 1),
      );
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);

      await poll();
      await poll();

      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(1);
    });

    it('re-arms and alerts again once the offender clears then recurs', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('8192');
      const entries = Array.from({ length: 5 }, (_, i) =>
        largeReplyEntry(['GET', `k${i}`], 20000, i + 1),
      );
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);
      await poll();
      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(1);

      // Recovery: cache goes empty (e.g. COMMANDLOG RESET).
      commandLogAnalytics.getCachedEntries.mockReturnValue([]);
      await poll();

      // Recurs.
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);
      await poll();

      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(2);
    });

    it('does not fire for a single rare large reply below the frequency floor', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('8192');
      commandLogAnalytics.getCachedEntries.mockReturnValue([largeReplyEntry(['GET', 'k'], 20000)]);

      await poll();

      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(0);
    });

    it('does not fire when replies are below the configured threshold', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('20000');
      const entries = Array.from({ length: 5 }, (_, i) =>
        largeReplyEntry(['GET', `k${i}`], 8192, i + 1),
      );
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);

      await poll();

      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(0);
    });

    it('does not fire when large-reply logging is disabled (threshold -1)', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('-1');
      const entries = Array.from({ length: 5 }, (_, i) =>
        largeReplyEntry(['GET', `k${i}`], 20000, i + 1),
      );
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);

      await poll();

      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(0);
    });

    it('re-arms when logging is disabled with lingering entries, so re-enabling alerts again', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('8192');
      const entries = Array.from({ length: 5 }, (_, i) =>
        largeReplyEntry(['GET', `k${i}`], 20000, i + 1),
      );
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);

      await poll();
      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(1);
      expect((service as any).activeLargeReplyOffenders.get('conn-1')?.size).toBeGreaterThan(0);

      // Logging disabled server-side (threshold -1) while cached entries linger:
      // the armed offender must be cleared, not left suppressing future alerts.
      (service as any).largeReplyThresholdCache.set('conn-1', -1);
      (service as any).largeReplyThresholdRecheck.set('conn-1', 5); // avoid a re-fetch
      await poll();
      expect((service as any).activeLargeReplyOffenders.get('conn-1')?.size ?? 0).toBe(0);

      // Re-enabled — the same command must alert again, not stay deduped.
      (service as any).largeReplyThresholdCache.set('conn-1', 8192);
      (service as any).largeReplyThresholdRecheck.set('conn-1', 5);
      await poll();
      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(2);
    });

    it('gracefully no-ops when CONFIG GET fails', async () => {
      dbClient.getConfigValue = jest.fn().mockRejectedValue(new Error('NOPERM'));
      const entries = Array.from({ length: 5 }, (_, i) =>
        largeReplyEntry(['GET', `k${i}`], 20000, i + 1),
      );
      commandLogAnalytics.getCachedEntries.mockReturnValue(entries);

      await expect(poll()).resolves.not.toThrow();
      expect(eventsOf(MetricType.LARGE_REPLY_PRESSURE)).toHaveLength(0);
    });
  });

  // ─── Data-Loss Detection (valkey/valkey#579) ─────────────────────────────

  describe('data-loss detection', () => {
    function mockReplInfo(
      opts: {
        role?: string;
        replid?: string;
        offset?: string;
        uptime?: string;
        connectedSlaves?: string;
        db0?: string;
        loading?: string;
        asyncLoading?: string;
      } = {},
    ) {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: opts.role ?? 'master', uptime_in_seconds: opts.uptime ?? '1000' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        persistence: { loading: opts.loading ?? '0', async_loading: opts.asyncLoading ?? '0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
        replication: {
          master_replid: opts.replid ?? 'replid-aaaa',
          master_repl_offset: opts.offset ?? '5000',
          connected_slaves: opts.connectedSlaves ?? '1',
        },
        // Run the fixture line through the real parser so these mocks always
        // match the shape getInfoParsed actually emits.
        keyspace:
          opts.db0 !== undefined
            ? MetricsParser.parseInfoToTyped({ keyspace: { db0: opts.db0 } }).keyspace
            : {},
      });
    }

    function dataLossEvents() {
      return service.getRecentEvents().filter((e) => e.metricType === MetricType.DATASET_KEYS);
    }

    it('does not fire on first poll (no previous snapshot)', async () => {
      mockReplInfo({ db0: 'keys=0,expires=0,avg_ttl=0' });
      await poll();
      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();
    });

    it('fires Rule A when primary restarts empty (replid changed, uptime reset)', async () => {
      mockReplInfo({
        replid: 'replid-aaaa',
        uptime: '1000',
        offset: '5000',
        db0: 'keys=150,expires=0,avg_ttl=0',
      });
      await poll();

      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0' }); // empty keyspace
      await poll();

      const events = dataLossEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].anomalyType).toBe(AnomalyType.DROP);
      expect(events[0].baseline).toBe(150);
      expect(events[0].value).toBe(0);
      expect(events[0].message).toContain('Primary restarted with an empty dataset');

      expect(webhookEventsProService.dispatchDataLossDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'primary_restarted_empty',
          previousKeys: 150,
          currentKeys: 0,
          previousReplid: 'replid-aaaa',
          newReplid: 'replid-bbbb',
          role: 'master',
          connectionId: 'conn-1',
        }),
      );
    });

    it('mirrors the anomaly to OTLP even when the Pro webhook is disabled', async () => {
      // OTLP export is its own opt-in channel (gated only by OTEL_* in the
      // dispatcher); a disabled or unconfigured Pro webhook must not suppress it
      // (valkey#4078).
      webhookEventsProService.isEnabled.mockReturnValue(false);

      mockReplInfo({
        replid: 'replid-aaaa',
        uptime: '1000',
        offset: '5000',
        db0: 'keys=150,expires=0,avg_ttl=0',
      });
      await poll();
      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0' }); // empty keyspace
      await poll();

      expect(dataLossEvents()).toHaveLength(1);
      expect(otelEvents.dispatch).toHaveBeenCalledWith(
        WebhookEventType.ANOMALY_DETECTED,
        expect.objectContaining({
          severity: AnomalySeverity.CRITICAL,
          metricType: MetricType.DATASET_KEYS,
          anomalyType: AnomalyType.DROP,
        }),
        'conn-1',
      );
    });

    it('fires Rule B when a replica is wiped by a full resync from an empty primary', async () => {
      mockReplInfo({ role: 'replica', replid: 'replid-aaaa', db0: 'keys=200,expires=0,avg_ttl=0' });
      await poll();

      mockReplInfo({ role: 'replica', replid: 'replid-cccc' }); // empty after resync
      await poll();

      const events = dataLossEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('Replica was wiped by a full resync');

      expect(webhookEventsProService.dispatchDataLossDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'replica_wiped',
          previousKeys: 200,
          currentKeys: 0,
          role: 'replica',
        }),
      );
    });

    it('does not fire when primary restarts but reloads its data', async () => {
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', db0: 'keys=150,expires=0,avg_ttl=0' });
      await poll();

      // Restarted (new replid, uptime reset) but keys intact via RDB/AOF reload
      mockReplInfo({
        replid: 'replid-bbbb',
        uptime: '5',
        offset: '0',
        db0: 'keys=150,expires=0,avg_ttl=0',
      });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();
    });

    it('does not fire on a restart while the server is still loading its dataset from disk', async () => {
      mockReplInfo({
        replid: 'replid-aaaa',
        uptime: '1000',
        offset: '5000',
        db0: 'keys=150,expires=0,avg_ttl=0',
      });
      await poll();

      // Restarted with RDB/AOF: new replid and empty keyspace, but INFO reports
      // loading in progress — keys are not lost, just not loaded yet.
      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0', loading: '1' });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();

      // Load finishes and the keyspace is restored — still no false alert
      // because the transient empty snapshot was never recorded as baseline.
      mockReplInfo({
        replid: 'replid-bbbb',
        uptime: '10',
        offset: '0',
        db0: 'keys=150,expires=0,avg_ttl=0',
      });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();
    });

    it('does not fire while async_loading (diskless) is in progress', async () => {
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', db0: 'keys=150,expires=0,avg_ttl=0' });
      await poll();

      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0', asyncLoading: '1' });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();
    });

    it('does not fire when replica replid changes after normal failover with keys preserved', async () => {
      mockReplInfo({ role: 'replica', replid: 'replid-aaaa', db0: 'keys=200,expires=0,avg_ttl=0' });
      await poll();

      // Partial/full resync from a healthy new primary — dataset preserved
      mockReplInfo({ role: 'replica', replid: 'replid-cccc', db0: 'keys=198,expires=0,avg_ttl=0' });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();
    });

    it('does not fire on FLUSHALL (empty dataset but same replid, no restart evidence)', async () => {
      mockReplInfo({
        replid: 'replid-aaaa',
        uptime: '1000',
        offset: '5000',
        db0: 'keys=150,expires=0,avg_ttl=0',
      });
      await poll();

      // Same replid, uptime and offset still advancing — intentional flush
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1001', offset: '5100' });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();
    });

    it('fires only once per transition (snapshot updated after firing)', async () => {
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', db0: 'keys=150,expires=0,avg_ttl=0' });
      await poll();
      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0' });
      await poll();
      mockReplInfo({ replid: 'replid-bbbb', uptime: '6', offset: '0' });
      await poll();

      expect(dataLossEvents()).toHaveLength(1);
      expect(webhookEventsProService.dispatchDataLossDetected).toHaveBeenCalledTimes(1);
    });

    it('cleans up prevReplSnapshot on connection removal', async () => {
      mockReplInfo({ db0: 'keys=10,expires=0,avg_ttl=0' });
      await poll();
      expect((service as any).prevReplSnapshot.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');
      expect((service as any).prevReplSnapshot.has('conn-1')).toBe(false);
    });

    it('resolveAnomaly marks the cached event resolved and persists to storage', async () => {
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', db0: 'keys=150,expires=0,avg_ttl=0' });
      await poll();
      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0' });
      await poll();

      const [event] = dataLossEvents();
      const success = await service.resolveAnomaly(event.id);

      expect(success).toBe(true);
      expect(event.resolved).toBe(true);
      expect(storage.resolveAnomaly).toHaveBeenCalledWith(event.id, expect.any(Number));
    });

    it('resolveAnomaly still succeeds via storage when the event is not in the in-memory cache (e.g. after restart)', async () => {
      storage.resolveAnomaly.mockResolvedValue(true);

      const success = await service.resolveAnomaly('persisted-but-not-cached');

      expect(success).toBe(true);
      expect(storage.resolveAnomaly).toHaveBeenCalledWith(
        'persisted-but-not-cached',
        expect.any(Number),
      );
    });

    it('resolveAnomaly returns false when the event exists neither in cache nor storage', async () => {
      storage.resolveAnomaly.mockResolvedValue(false);

      expect(await service.resolveAnomaly('unknown-id')).toBe(false);
    });

    it('resolveAnomaly reports failure and leaves the cached event unresolved when persistence fails', async () => {
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', db0: 'keys=150,expires=0,avg_ttl=0' });
      await poll();
      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0' });
      await poll();

      storage.resolveAnomaly.mockRejectedValue(new Error('db down'));

      const [event] = dataLossEvents();
      // A non-durable resolution must not report success, otherwise the UI could
      // dismiss a banner that storage-backed polls still return as unresolved.
      expect(await service.resolveAnomaly(event.id)).toBe(false);
      expect(event.resolved).toBe(false);
    });

    it('resolveGroup persists every member and reports success only when all persist', async () => {
      storage.resolveAnomaly.mockResolvedValue(true);
      const a1 = { id: 'a1', resolved: false, persisted: true } as any;
      const a2 = { id: 'a2', resolved: false, persisted: true } as any;
      (service as any).recentGroups = [{ correlationId: 'grp-1', anomalies: [a1, a2] }];

      expect(await service.resolveGroup('grp-1')).toBe(true);
      expect(a1.resolved).toBe(true);
      expect(a2.resolved).toBe(true);
      expect(storage.resolveAnomaly).toHaveBeenCalledWith('a1', expect.any(Number));
      expect(storage.resolveAnomaly).toHaveBeenCalledWith('a2', expect.any(Number));
    });

    it('resolveGroup reports failure and leaves unpersisted members unresolved', async () => {
      // a1 persists; a2 throws.
      storage.resolveAnomaly.mockImplementation((id: string) =>
        id === 'a2' ? Promise.reject(new Error('db down')) : Promise.resolve(true),
      );
      const a1 = { id: 'a1', resolved: false, persisted: true } as any;
      const a2 = { id: 'a2', resolved: false, persisted: true } as any;
      (service as any).recentGroups = [{ correlationId: 'grp-2', anomalies: [a1, a2] }];

      expect(await service.resolveGroup('grp-2')).toBe(false);
      expect(a1.resolved).toBe(true); // durable → cache flipped
      expect(a2.resolved).toBe(false); // failed → left unresolved
    });

    it('resolveGroup returns false when storage reports no row updated', async () => {
      storage.resolveAnomaly.mockResolvedValue(false);
      const a1 = { id: 'a1', resolved: false, persisted: true } as any;
      (service as any).recentGroups = [{ correlationId: 'grp-3', anomalies: [a1] }];

      expect(await service.resolveGroup('grp-3')).toBe(false);
      expect(a1.resolved).toBe(false);
    });

    // Deterministic string-id events (failover/promotion/cluster/persistence/
    // dup-primary) can't be stored on Postgres (UUID PK), so saveAnomalyEvent
    // throws in addAnomaly and they stay memory-only. Resolution must still work
    // by flipping the cache — a storage-backed poll can never resurface a row
    // that was never written. Without this they were undismissable on Postgres.
    it('resolveAnomaly dismisses a memory-only (never-persisted) event without touching storage', async () => {
      const event = { id: 'conn-failover-123', resolved: false, persisted: false } as any;
      (service as any).recentAnomalies = [event];

      expect(await service.resolveAnomaly('conn-failover-123')).toBe(true);
      expect(event.resolved).toBe(true);
      expect(storage.resolveAnomaly).not.toHaveBeenCalled();
    });

    it('addAnomaly leaves an event memory-only when the store rejects its id, and it stays dismissable', async () => {
      // Simulate Postgres rejecting the non-UUID id.
      storage.saveAnomalyEvent.mockRejectedValueOnce(
        new Error('invalid input syntax for type uuid'),
      );
      const event = {
        id: 'conn-persistence-error',
        metricType: 'persistence',
        anomalyType: 'state',
        severity: 'warning',
        message: 'x',
        resolved: false,
      } as any;

      await (service as any).addAnomaly(event, { connectionId: 'conn' });
      expect(event.persisted).toBeFalsy();

      // resolveAnomaly falls back to the in-memory flip.
      storage.resolveAnomaly.mockClear();
      expect(await service.resolveAnomaly('conn-persistence-error')).toBe(true);
      expect(event.resolved).toBe(true);
      expect(storage.resolveAnomaly).not.toHaveBeenCalled();
    });

    it('resolveGroup dismisses memory-only members via the cache', async () => {
      const a1 = { id: 'conn-failover-1', resolved: false, persisted: false } as any;
      const a2 = { id: 'conn-cluster-2', resolved: false, persisted: false } as any;
      (service as any).recentGroups = [{ correlationId: 'grp-mem', anomalies: [a1, a2] }];

      expect(await service.resolveGroup('grp-mem')).toBe(true);
      expect(a1.resolved).toBe(true);
      expect(a2.resolved).toBe(true);
      expect(storage.resolveAnomaly).not.toHaveBeenCalled();
    });
  });

  // ─── Keyspace key counting (shape robustness) ────────────────────────────
  // parseInfoToTyped emits each keyspace db* entry as a { keys, expires,
  // avg_ttl } object; strings only appear for non-db or unparseable lines. The
  // count must be read off the typed INFO response (not the stringified flat
  // record, which would collapse an object to "[object Object]").
  describe('sumKeyspaceKeys', () => {
    const sum = (infoResponse: unknown): number => (service as any).sumKeyspaceKeys(infoResponse);

    it('sums the typed object shape emitted by the real parser', () => {
      expect(
        sum(
          MetricsParser.parseInfoToTyped({
            keyspace: { db0: 'keys=150,expires=5,avg_ttl=0', db1: 'keys=42,expires=0,avg_ttl=0' },
          }),
        ),
      ).toBe(192);
    });

    it('sums pre-typed object values', () => {
      expect(
        sum({
          keyspace: {
            db0: { keys: 150, expires: 5, avg_ttl: 0 },
            db1: { keys: 42, expires: 0, avg_ttl: 0 },
          },
        }),
      ).toBe(192);
    });

    it('ignores raw-string values and returns 0 for an empty or missing keyspace', () => {
      expect(sum({ keyspace: {} })).toBe(0);
      expect(sum({})).toBe(0);
      expect(sum({ keyspace: { note: 'keys=999', db0: 'garbage' } })).toBe(0);
    });
  });

  // ─── Active-incident feed (data-loss banner) ─────────────────────────────
  // The banner must surface UNRESOLVED incidents of any age, so activeOnly must
  // query durable storage with resolved:false and no startTime floor. A 24h
  // window (the default for the normal feed) would hide an older open incident.
  describe('getRecentAnomalies activeOnly', () => {
    const oldOpenEvent = {
      id: 'evt-old',
      timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000, // 3 days ago
      metricType: 'dataset_keys',
      anomalyType: 'drop',
      severity: 'critical',
      value: 0,
      baseline: 100,
      stdDev: 0,
      zScore: 0,
      threshold: 0,
      message: 'CRITICAL: Primary restarted with an empty dataset',
      resolved: false,
    };

    it('queries storage for unresolved events with no startTime floor', async () => {
      storage.getAnomalyEvents.mockResolvedValue([oldOpenEvent]);

      const events = await service.getRecentAnomalies(
        undefined,
        undefined,
        undefined,
        MetricType.DATASET_KEYS,
        100,
        undefined,
        true,
      );

      expect(storage.getAnomalyEvents).toHaveBeenCalledWith(
        expect.objectContaining({ resolved: false, metricType: 'dataset_keys' }),
      );
      const callArg = storage.getAnomalyEvents.mock.calls.at(-1)![0];
      expect(callArg.startTime).toBeUndefined(); // no 24h floor → old incident survives
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-old');
      expect(events[0].resolved).toBe(false);
    });

    it('unions in-memory unresolved events not yet in storage (persist failure still banners)', async () => {
      storage.getAnomalyEvents.mockResolvedValue([]);
      // A fresh incident whose saveAnomalyEvent failed lives only in the cache; the banner
      // must still surface it rather than wait for a later poll to make it durable.
      (service as any).recentAnomalies = [{ ...oldOpenEvent, id: 'in-mem', timestamp: Date.now() }];

      const events = await service.getRecentAnomalies(
        undefined,
        undefined,
        undefined,
        MetricType.DATASET_KEYS,
        100,
        undefined,
        true,
      );

      expect(storage.getAnomalyEvents).toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('in-mem');
    });

    it('dedupes by id when an event is both cached and persisted', async () => {
      storage.getAnomalyEvents.mockResolvedValue([oldOpenEvent]);
      (service as any).recentAnomalies = [{ ...oldOpenEvent, timestamp: Date.now() }];

      const events = await service.getRecentAnomalies(
        undefined,
        undefined,
        undefined,
        MetricType.DATASET_KEYS,
        100,
        undefined,
        true,
      );

      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-old');
    });

    it('excludes resolved in-memory events from the active feed', async () => {
      storage.getAnomalyEvents.mockResolvedValue([]);
      (service as any).recentAnomalies = [
        { ...oldOpenEvent, id: 'done', resolved: true, timestamp: Date.now() },
      ];

      const events = await service.getRecentAnomalies(
        undefined,
        undefined,
        undefined,
        MetricType.DATASET_KEYS,
        100,
        undefined,
        true,
      );

      expect(events).toHaveLength(0);
    });
  });

  // ─── Cluster State Webhook Dispatch ──────────────────────────────────────

  describe('cluster state webhook dispatch', () => {
    it('dispatches cluster.failover webhook on ok→fail transition', async () => {
      // First poll: establish cluster state as 'ok'
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: {
          used_memory: '1000000',
          allocator_frag_ratio: '1.1',
          mem_fragmentation_ratio: '1.5',
        },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
          cluster_enabled: '1',
        },
      });
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({
        cluster_state: 'ok',
        cluster_slots_assigned: '16384',
        cluster_slots_fail: '0',
        cluster_known_nodes: '6',
      });
      await poll();

      // Second poll: cluster state transitions to 'fail'
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue({
        cluster_state: 'fail',
        cluster_slots_assigned: '16384',
        cluster_slots_fail: '2048',
        cluster_known_nodes: '6',
      });
      await poll();

      expect(webhookEventsProService.dispatchClusterFailover).toHaveBeenCalledWith(
        expect.objectContaining({
          clusterState: 'fail',
          previousState: 'ok',
          slotsAssigned: 16384,
          slotsFailed: 2048,
          knownNodes: 6,
          instance: { host: 'localhost', port: 6379 },
          connectionId: 'conn-1',
        }),
      );
    });

    it('does not mirror cluster.failover to OTLP (PrometheusService owns that emit)', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
          cluster_enabled: '1',
        },
      });
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({
        cluster_state: 'ok',
        cluster_slots_assigned: '16384',
        cluster_slots_fail: '0',
        cluster_known_nodes: '6',
      });
      await poll();

      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue({
        cluster_state: 'fail',
        cluster_slots_assigned: '16384',
        cluster_slots_fail: '2048',
        cluster_known_nodes: '6',
      });
      await poll();

      expect(webhookEventsProService.dispatchClusterFailover).toHaveBeenCalled();
      expect(otelEvents.dispatch).not.toHaveBeenCalledWith(
        WebhookEventType.CLUSTER_FAILOVER,
        expect.anything(),
        expect.anything(),
      );
    });
  });

  // ─── Persistence-Child Stall Detection (BGSAVE / AOF rewrite) ────────────

  describe('persistence-child stall detection', () => {
    const IDLE_PERSISTENCE = {
      rdb_bgsave_in_progress: '0',
      rdb_current_bgsave_time_sec: '-1',
      rdb_last_bgsave_status: 'ok',
      current_save_keys_processed: '0',
      current_save_keys_total: '0',
      aof_rewrite_in_progress: '0',
      aof_current_rewrite_time_sec: '-1',
      aof_last_bgrewrite_status: 'ok',
    };

    let now: number;

    beforeEach(() => {
      now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function mockPersistence(persistence: Record<string, string>): void {
      dbClient.getInfoParsed = jest.fn().mockResolvedValue({
        server: { role: 'master' },
        clients: { connected_clients: '10', blocked_clients: '0' },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: '0',
          acl_access_denied_auth: '0',
        },
        persistence: { ...IDLE_PERSISTENCE, ...persistence },
      });
    }

    const persistenceEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.PERSISTENCE_CHILD);

    it('excludes PERSISTENCE_CHILD from the initial buffer loop', async () => {
      mockPersistence({});
      await poll();
      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.PERSISTENCE_CHILD)).toBe(false);
    });

    it('fires nothing when no persistence child is running', async () => {
      mockPersistence({});
      await poll();
      now += 60_000;
      await poll();
      expect(persistenceEvents()).toHaveLength(0);
    });

    it('does not fire on the first in-progress observation (no baseline)', async () => {
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();
      expect(persistenceEvents()).toHaveLength(0);
    });

    it('does not fire while a BGSAVE keeps advancing under the warn threshold', async () => {
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '1000',
        current_save_keys_total: '42657',
      });
      await poll();

      now += 30_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '35',
        current_save_keys_processed: '20000',
        current_save_keys_total: '42657',
      });
      await poll();

      expect(persistenceEvents()).toHaveLength(0);
    });

    it('fires CRITICAL when BGSAVE progress freezes past the stall threshold', async () => {
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      now += 61_000; // exceeds the 60s stall threshold with no key progress
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '66',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('stuck');
      expect(events[0].message).toContain('BGSAVE');
      expect(events[0].message).toContain('1/42657');
    });

    it('reports a frozen BGSAVE only once per episode', async () => {
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      now += 61_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '66',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      now += 61_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '127',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      expect(persistenceEvents()).toHaveLength(1);
    });

    it('fires WARNING for a long-running but still-advancing BGSAVE', async () => {
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '100',
        current_save_keys_processed: '1000',
        current_save_keys_total: '999999',
      });
      await poll();

      now += 30_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '130', // over the 120s warn threshold
        current_save_keys_processed: '2000', // still advancing
        current_save_keys_total: '999999',
      });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('running long');
    });

    it('fires CRITICAL when the last BGSAVE status transitions ok→err', async () => {
      mockPersistence({ rdb_last_bgsave_status: 'ok' });
      await poll(); // baseline status

      mockPersistence({ rdb_last_bgsave_status: 'err' });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('reported an error');
    });

    it('fires on a pre-existing err status at the first poll (no ok baseline)', async () => {
      // Level-triggered: an err already present when monitoring starts must be
      // caught on the first observation, not only on an ok->err edge.
      mockPersistence({ rdb_last_bgsave_status: 'err' });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('reported an error');
    });

    it('reports a persisting err status once, re-arming after an ok sample', async () => {
      mockPersistence({ rdb_last_bgsave_status: 'err' });
      await poll();
      now += 1_000;
      await poll(); // still err — latch suppresses a duplicate
      expect(persistenceEvents()).toHaveLength(1);

      now += 1_000;
      mockPersistence({ rdb_last_bgsave_status: 'ok' });
      await poll(); // ok re-arms the latch

      now += 1_000;
      mockPersistence({ rdb_last_bgsave_status: 'err' });
      await poll(); // a fresh failure fires again

      expect(persistenceEvents()).toHaveLength(2);
    });

    it('fires CRITICAL with the time-ceiling reason when elapsed crosses the crit ceiling', async () => {
      // Distinct from a frozen-progress stall: keys may still be advancing, so
      // the event reports the duration ceiling rather than "no progress".
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '100',
      });
      await poll();

      now += 5_000;
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '605',
      });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].threshold).toBe(600);
      expect(events[0].message).toContain('time ceiling');
      expect(events[0].message).not.toContain('no progress');
    });

    it('does not fire a frozen stall once all keys are serialized (flush/fsync/rename tail)', async () => {
      // All keys written (processed === total) but the child stays in_progress through the
      // RDB flush/fsync/rename tail, so processed is frozen at N/N. This must NOT be reported
      // as "appears stuck" even past the stall window, as long as it's under the time ceiling.
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '42657',
        current_save_keys_total: '42657',
      });
      await poll(); // baseline

      now += 61_000; // past the 60s stall window with no key progress...
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '66', // ...but well under the warn/crit ceilings
        current_save_keys_processed: '42657',
        current_save_keys_total: '42657',
      });
      await poll();

      expect(persistenceEvents()).toHaveLength(0);
    });

    it('still catches a genuine hang in the serialization tail via the time ceiling', async () => {
      // processed === total (tail phase), so the frozen-progress path is suppressed — but a
      // child truly wedged in fsync eventually crosses the crit ceiling and fires 'exceeded'
      // with the duration message, not the misleading "stuck / no progress" one.
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '100',
        current_save_keys_processed: '42657',
        current_save_keys_total: '42657',
      });
      await poll(); // baseline

      now += 5_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '605', // past the 600s crit ceiling
        current_save_keys_processed: '42657',
        current_save_keys_total: '42657',
      });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].threshold).toBe(600);
      expect(events[0].message).toContain('time ceiling');
      expect(events[0].message).not.toContain('stuck');
    });

    it('does not fire a frozen stall when the total keys count is unavailable', async () => {
      // Without current_save_keys_total we can't tell the completion tail from a real stall,
      // so frozen-progress detection is skipped and only the elapsed-time ceilings apply.
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '1',
        current_save_keys_total: '', // absent/unparseable -> null
      });
      await poll(); // baseline

      now += 61_000; // past the 60s stall window with frozen processed...
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '66', // ...but under the warn/crit ceilings
        current_save_keys_processed: '1',
        current_save_keys_total: '',
      });
      await poll();

      expect(persistenceEvents()).toHaveLength(0);
    });

    it('fires CRITICAL when an AOF rewrite exceeds the hard elapsed ceiling', async () => {
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '100',
      });
      await poll(); // baseline

      now += 5_000;
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '605', // past the 600s critical ceiling
      });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('AOF rewrite');
    });

    it('clears tracked state when the persistence child finishes', async () => {
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();
      expect((service as any).lastPersistenceState.get('conn-1').rdb).toBeDefined();

      mockPersistence({});
      await poll();
      expect((service as any).lastPersistenceState.get('conn-1').rdb).toBeUndefined();
    });

    it('cleans up lastPersistenceState on connection removal', async () => {
      mockPersistence({ rdb_bgsave_in_progress: '1', rdb_current_bgsave_time_sec: '5' });
      await poll();
      expect((service as any).lastPersistenceState.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');
      expect((service as any).lastPersistenceState.has('conn-1')).toBe(false);
    });

    it('re-baselines a new BGSAVE started between polls (no false stall)', async () => {
      // Episode A advances normally to a high processed-key count.
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '100',
        current_save_keys_processed: '50000',
        current_save_keys_total: '999999',
      });
      await poll();

      now += 10_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '110',
        current_save_keys_processed: '60000',
        current_save_keys_total: '999999',
      });
      await poll();

      // A finishes and a fresh child B starts before any idle poll is seen:
      // both elapsed and processed regress, signalling a new episode.
      now += 5_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '2',
        current_save_keys_processed: '100',
        current_save_keys_total: '999999',
      });
      await poll();

      // B keeps advancing but stays below A's high-water processed count. With a
      // reused track this looks frozen for >60s (stale lastAdvanceTs) and would
      // fire a false CRITICAL; re-baselining treats B's progress as real.
      now += 61_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '63',
        current_save_keys_processed: '5000',
        current_save_keys_total: '999999',
      });
      await poll();

      expect(persistenceEvents()).toHaveLength(0);
    });

    it('detects a stalled new BGSAVE episode after a prior one already alerted', async () => {
      // Episode A freezes and fires CRITICAL.
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '5',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      now += 61_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '66',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();
      expect(persistenceEvents()).toHaveLength(1);

      // A new child B starts between polls (elapsed regresses) — the carried-over
      // reportedStall must not suppress B's own stall.
      now += 5_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '3',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      now += 61_000;
      mockPersistence({
        rdb_bgsave_in_progress: '1',
        rdb_current_bgsave_time_sec: '64',
        current_save_keys_processed: '1',
        current_save_keys_total: '42657',
      });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(2);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[1].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('re-baselines a restarted AOF rewrite via elapsed regression', async () => {
      // AOF exposes no per-key progress, so restart detection relies on elapsed.
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '100',
      });
      await poll();

      now += 5_000;
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '605', // past the 600s ceiling → CRITICAL
      });
      await poll();
      expect(persistenceEvents()).toHaveLength(1);

      // New rewrite starts between polls (elapsed drops); its own overrun must
      // still alert rather than being suppressed by the prior reportedStall.
      now += 5_000;
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '10',
      });
      await poll();

      now += 5_000;
      mockPersistence({
        aof_rewrite_in_progress: '1',
        aof_current_rewrite_time_sec: '610',
      });
      await poll();

      const events = persistenceEvents();
      expect(events).toHaveLength(2);
      expect(events[1].severity).toBe(AnomalySeverity.CRITICAL);
    });
  });

  // ─── Duplicate-primary (split-brain) detection ─────────────────────────────
  describe('duplicate primary detection', () => {
    const clusterInfoResponse = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterInfoResponse);
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({ cluster_state: 'ok' });
    });

    const healthyNodes = [
      {
        id: 'a',
        address: '10.0.0.1:6379@16379',
        flags: ['myself', 'master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [[0, 8191]],
      },
      {
        id: 'b',
        address: '10.0.0.2:6379@16379',
        flags: ['master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 2,
        linkState: 'connected',
        slots: [[8192, 16383]],
      },
    ];

    const splitBrainNodes = [
      {
        id: 'nodeAAAAAAAA',
        address: '10.0.0.1:6379@16379',
        flags: ['myself', 'master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 4,
        linkState: 'connected',
        slots: [[0, 5460]],
      },
      {
        id: 'nodeCCCCCCCC',
        address: '10.0.0.3:6379@16379',
        flags: ['master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 9,
        linkState: 'connected',
        slots: [[0, 5460]],
      },
    ];

    it('emits a CRITICAL anomaly when two primaries claim the same slots', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(splitBrainNodes);
      await poll();

      const events = service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY);
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      // Phantom is the lower-epoch node A; message points it at authoritative node C.
      expect(events[0].message).toContain('nodeAAAA');
      expect(events[0].message).toContain('nodeCCCC');
      expect(events[0].message).toContain('split-brain');
    });

    it('emits no topology anomaly for a healthy cluster', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(healthyNodes);
      await poll();

      const events = service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY);
      expect(events).toHaveLength(0);
    });

    it('dedupes a persistent conflict to a single alert across polls', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(splitBrainNodes);
      await poll();
      await poll();
      await poll();

      const events = service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY);
      expect(events).toHaveLength(1);
    });

    it('re-alerts when a conflict resolves and later recurs', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(splitBrainNodes);
      await poll(); // conflict → 1 alert

      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(healthyNodes);
      await poll(); // resolved → clears dedupe

      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(splitBrainNodes);
      await poll(); // recurs → new alert

      const events = service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY);
      expect(events).toHaveLength(2);
    });

    it('does not throw when getClusterNodes fails', async () => {
      dbClient.getClusterNodes = jest.fn().mockRejectedValue(new Error('CLUSTER NODES failed'));
      await expect(poll()).resolves.not.toThrow();

      const events = service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY);
      expect(events).toHaveLength(0);
    });

    it('re-alerts on a recurring conflict after an intervening failed poll (no stale dedupe)', async () => {
      // Poll 1: conflict observed → alert, signature stored.
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(splitBrainNodes);
      await poll();

      // Poll 2: poll fails — no observation, dedupe state must be cleared so a
      // possible missed heal cannot suppress the next alert.
      (dbClient.getClusterNodes as jest.Mock).mockRejectedValue(new Error('CLUSTER NODES failed'));
      await poll();

      // Poll 3: conflict present again → must re-alert.
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(splitBrainNodes);
      await poll();

      const events = service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY);
      expect(events).toHaveLength(2);
    });
  });

  // ─── Stuck-replica detection (valkey-io/valkey#2090) ───────────────────────
  describe('stuck replica detection', () => {
    const clusterInfoResponse = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    let now: number;

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterInfoResponse);
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({ cluster_state: 'ok' });
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const healthyNodes = [
      {
        id: 'primA',
        address: '10.0.0.1:6379@16379',
        flags: ['myself', 'master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [[0, 16383]],
      },
      {
        id: 'repB',
        address: '10.0.0.2:6380@16380',
        flags: ['slave'],
        master: 'primA',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
      },
    ];

    // valkey#2090: repB still replicates the dead old primary while a fresh
    // primary (newprim) took over the shard; repB never re-attaches.
    const orphanedNodes = [
      {
        id: 'newprim',
        address: '10.0.0.1:6379@16379',
        flags: ['master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 6,
        linkState: 'connected',
        slots: [[0, 16383]],
      },
      {
        id: 'repB',
        address: '10.0.0.2:6380@16380',
        flags: ['myself', 'slave'],
        master: 'deadprim',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
      },
      {
        id: 'deadprim',
        address: ':0@0',
        flags: ['master', 'fail', 'noaddr'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'disconnected',
        slots: [],
      },
    ];

    const topoEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY);

    it('does not alert on first observation (within the failover grace window)', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(orphanedNodes);
      await poll();
      expect(topoEvents()).toHaveLength(0);
    });

    it('does not alert on a transient orphaned window that resolves (normal failover)', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(orphanedNodes);
      await poll(); // t0: orphaned observed, within grace
      now += 5_000;
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(healthyNodes);
      await poll(); // t0+5s: recovered before the grace window elapsed
      expect(topoEvents()).toHaveLength(0);
    });

    it('emits a WARNING once the orphaned replica persists past the grace window', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(orphanedNodes);
      await poll(); // t0: within grace, no alert
      expect(topoEvents()).toHaveLength(0);

      now += 31_000; // exceed STUCK_REPLICA_MIN_PERSIST_MS (30s)
      await poll();

      const events = topoEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('2090');
      expect(events[0].message).toContain('CLUSTER REPLICATE');
      expect(events[0].message).toContain('repB'.substring(0, 8));
    });

    it('dedupes a persistent stuck replica to a single alert across polls', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(orphanedNodes);
      await poll();
      now += 31_000;
      await poll(); // fires
      now += 5_000;
      await poll(); // still stuck, deduped
      expect(topoEvents()).toHaveLength(1);
    });

    it('re-alerts when a stuck replica recovers and later goes stuck again', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(orphanedNodes);
      await poll();
      now += 31_000;
      await poll(); // fires (1)

      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(healthyNodes);
      now += 5_000;
      await poll(); // recovered → clears grace + dedupe

      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(orphanedNodes);
      now += 5_000;
      await poll(); // stuck again, within a fresh grace window → no alert yet
      now += 31_000;
      await poll(); // persisted again → fires (2)

      expect(topoEvents()).toHaveLength(2);
    });

    it('does not alert for a healthy shard', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(healthyNodes);
      await poll();
      now += 31_000;
      await poll();
      expect(topoEvents()).toHaveLength(0);
    });

    it('does not throw when getClusterNodes fails', async () => {
      dbClient.getClusterNodes = jest.fn().mockRejectedValue(new Error('CLUSTER NODES failed'));
      await expect(poll()).resolves.not.toThrow();
      expect(topoEvents()).toHaveLength(0);
    });
  });

  describe('replica slot-state detection (valkey#1664)', () => {
    const clusterInfoResponse = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    let now: number;

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterInfoResponse);
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({ cluster_state: 'ok' });
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const healthyNodes = [
      {
        id: 'primA',
        address: '10.0.0.1:6379@16379',
        flags: ['myself', 'master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [[0, 16383]],
      },
      {
        id: 'repB',
        address: '10.0.0.2:6380@16380',
        flags: ['slave'],
        master: 'primA',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
      },
    ];

    // valkey#1664: repB (a replica) wrongly reports slot 42 in importing state.
    const badReplicaNodes = [
      {
        id: 'primA',
        address: '10.0.0.1:6379@16379',
        flags: ['myself', 'master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [[0, 16383]],
      },
      {
        id: 'repB',
        address: '10.0.0.2:6380@16380',
        flags: ['slave'],
        master: 'primA',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
        importingSlots: [{ slot: 42, sourceNodeId: 'primA' }],
      },
    ];

    const shards = [
      {
        slots: [[0, 16383]],
        nodes: [
          { id: 'primA', role: 'master' },
          { id: 'repB', role: 'replica' },
        ],
      },
    ];
    // CLUSTER SHARDS disagrees with CLUSTER NODES: repB is actually a master
    // (mid-promotion), so its slot state is legitimate and must not alert.
    const shardsRepBIsMaster = [
      {
        slots: [[0, 16383]],
        nodes: [
          { id: 'primA', role: 'replica' },
          { id: 'repB', role: 'master' },
        ],
      },
    ];

    const slotEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.REPLICA_SLOT_STATE);

    it('does not alert within the persistence grace window', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      expect(slotEvents()).toHaveLength(0);
    });

    it('emits a WARNING once the bad replica slot state persists past the grace window', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      expect(slotEvents()).toHaveLength(0);

      now += 31_000; // exceed REPLICA_SLOT_STATE_MIN_PERSIST_MS (30s)
      await poll();

      const events = slotEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('1664');
      expect(events[0].message).toContain('CLUSTER SETSLOT');
      expect(events[0].message).toContain('IMPORTING');
    });

    it('suppresses the alert when CLUSTER SHARDS reports the node is a master (mid-promotion)', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shardsRepBIsMaster);
      await poll();
      now += 31_000;
      await poll();
      expect(slotEvents()).toHaveLength(0);
    });

    it('still detects via CLUSTER NODES when CLUSTER SHARDS is unavailable (degrade)', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockRejectedValue(new Error('ERR unknown subcommand'));
      await poll();
      now += 31_000;
      await poll();
      expect(slotEvents()).toHaveLength(1);
    });

    it('dedupes a persistent condition to a single alert across polls', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll(); // fires
      now += 5_000;
      await poll(); // still stuck, deduped
      expect(slotEvents()).toHaveLength(1);
    });

    it('does not alert for a healthy shard', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(healthyNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll();
      expect(slotEvents()).toHaveLength(0);
    });

    it('does not throw when getClusterNodes fails', async () => {
      dbClient.getClusterNodes = jest.fn().mockRejectedValue(new Error('CLUSTER NODES failed'));
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await expect(poll()).resolves.not.toThrow();
      expect(slotEvents()).toHaveLength(0);
    });

    it('does NOT re-fire a duplicate after a transient CLUSTER NODES failure', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll(); // fires (1)
      // Transient fetch failure — must not clear dedupe state.
      (dbClient.getClusterNodes as jest.Mock).mockRejectedValueOnce(new Error('blip'));
      now += 5_000;
      await poll(); // observation gap
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(badReplicaNodes);
      now += 5_000;
      await poll(); // still stuck — deduped, no second alert
      expect(slotEvents()).toHaveLength(1);
    });

    it('auto-resolves the emitted event when the condition clears', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll(); // fires
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);

      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(healthyNodes);
      now += 5_000;
      await poll(); // recovered → auto-resolve so the activeOnly banner clears
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(0);
    });

    it('retries auto-resolution after a failure so the banner is not left stuck open', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll(); // fires
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);

      // Recovered, but resolution fails this poll → event stays unresolved, retry pending.
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(healthyNodes);
      storage.resolveAnomaly.mockResolvedValueOnce(false);
      now += 5_000;
      await poll();
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);

      // Next poll retries; resolution now succeeds → event resolves, banner clears.
      now += 5_000;
      await poll();
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(0);
    });

    it('stops retrying auto-resolution once the event is gone from both cache and storage', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll(); // fires
      const fired = slotEvents().filter((e) => !e.resolved);
      expect(fired).toHaveLength(1);

      // Simulate the emitted event being evicted from the 1000-cap cache while it
      // was never durably persisted (a deterministic id the Postgres UUID PK
      // rejected) — storage can never resolve it, so resolution is impossible.
      const recent = (service as any).recentAnomalies as Array<{ id: string }>;
      recent.splice(
        recent.findIndex((a) => a.id === fired[0].id),
        1,
      );
      storage.resolveAnomaly.mockResolvedValue(false);

      // Recover → auto-resolve runs once, sees the event is gone, drops the mapping.
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(healthyNodes);
      now += 5_000;
      await poll();
      const callsAfterGiveUp = storage.resolveAnomaly.mock.calls.length;
      expect(callsAfterGiveUp).toBeGreaterThanOrEqual(1);

      // Subsequent recovered polls must NOT retry the gone event forever.
      now += 5_000;
      await poll();
      now += 5_000;
      await poll();
      expect(storage.resolveAnomaly.mock.calls.length).toBe(callsAfterGiveUp);
    });

    it('does not orphan an unresolved event when the same signature recurs after a failed resolve', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll(); // fires E1
      expect(slotEvents()).toHaveLength(1);

      // Recover, resolution fails → E1 kept for retry.
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(healthyNodes);
      storage.resolveAnomaly.mockResolvedValueOnce(false);
      now += 5_000;
      await poll();
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);

      // Same signature recurs before E1 resolved → must reuse E1, not emit a 2nd.
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(badReplicaNodes);
      await poll(); // recurrence observed (fresh grace)
      now += 31_000;
      await poll(); // grace passed — E1 reused, no duplicate/orphan
      expect(slotEvents()).toHaveLength(1);
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);
    });

    it('re-alerts if an operator dismisses the banner while the replica is still stuck', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(badReplicaNodes);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(shards);
      await poll();
      now += 31_000;
      await poll(); // fires E1
      const active1 = slotEvents().filter((e) => !e.resolved);
      expect(active1).toHaveLength(1);

      // Operator dismisses the banner while the replica is STILL stuck.
      await service.resolveAnomaly(active1[0].id);
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(0);

      // Condition persists → the non-self-healing alert must re-pin, not stay muted.
      now += 5_000;
      await poll();
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);
    });

    it('fan-out trusts the node self-reported role, so a stale-promoted primary is not flagged', async () => {
      // The connected node's gossip view still calls bbbbbbbb a replica (stale).
      const primaryView = [
        {
          id: 'aaaaaaaa',
          address: '10.0.0.1:6379@16379',
          flags: ['myself', 'master'],
          master: '',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[0, 8191]],
        },
        {
          id: 'bbbbbbbb',
          address: '10.0.0.2:6380@16380',
          flags: ['slave'],
          master: 'aaaaaaaa',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [],
        },
      ];
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(primaryView);
      dbClient.getClusterShards = jest.fn().mockResolvedValue([
        { slots: [[0, 8191]], nodes: [{ id: 'aaaaaaaa', role: 'master' }] },
        { slots: [[8192, 16383]], nodes: [{ id: 'bbbbbbbb', role: 'master' }] },
      ]);
      // bbbbbbbb's OWN line: it is actually a primary now, legitimately owning slots.
      const selfView =
        'aaaaaaaa 10.0.0.1:6379@16379 master - 0 0 1 connected 0-8191\n' +
        'bbbbbbbb 10.0.0.2:6380@16380 myself,master - 0 0 2 connected 8192-16383';
      const nodeClient = { call: jest.fn().mockResolvedValue(selfView) };
      (service as any).clusterDiscovery = {
        getNodeConnection: jest.fn().mockResolvedValue(nodeClient),
      };

      await poll();
      now += 31_000;
      await poll();
      // A live primary owning its slots is NOT a divergent replica.
      expect(slotEvents()).toHaveLength(0);
    });

    it('fan-out skips replicas flagged dead/unreachable (no wasted connect attempts)', async () => {
      const primaryView = [
        {
          id: 'aaaaaaaa',
          address: '10.0.0.1:6379@16379',
          flags: ['myself', 'master'],
          master: '',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[0, 16383]],
        },
        {
          id: 'bbbbbbbb',
          address: '10.0.0.2:6380@16380',
          flags: ['slave', 'fail'],
          master: 'aaaaaaaa',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'disconnected',
          slots: [],
        },
      ];
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(primaryView);
      dbClient.getClusterShards = jest.fn().mockResolvedValue([
        {
          slots: [[0, 16383]],
          nodes: [
            { id: 'aaaaaaaa', role: 'master' },
            { id: 'bbbbbbbb', role: 'replica' },
          ],
        },
      ]);
      const getNodeConnection = jest.fn().mockResolvedValue({ call: jest.fn() });
      (service as any).clusterDiscovery = { getNodeConnection };

      await poll();
      now += 31_000;
      await poll();
      // bbbbbbbb is a replica flagged `fail` — it must never be dialed.
      expect(getNodeConnection).not.toHaveBeenCalled();
    });

    it('per-node fan-out surfaces a stuck replica invisible in the connected node view', async () => {
      // The connected node (primary) view lists the replica with NO migration
      // markers — they are node-local. Fan-out queries the replica directly.
      const primaryView = [
        {
          id: 'aaaaaaaa',
          address: '10.0.0.1:6379@16379',
          flags: ['myself', 'master'],
          master: '',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [[0, 16383]],
        },
        {
          id: 'bbbbbbbb',
          address: '10.0.0.2:6380@16380',
          flags: ['slave'],
          master: 'aaaaaaaa',
          pingSent: 0,
          pongReceived: 0,
          configEpoch: 1,
          linkState: 'connected',
          slots: [],
        },
      ];
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(primaryView);
      dbClient.getClusterShards = jest.fn().mockResolvedValue([
        {
          slots: [[0, 16383]],
          nodes: [
            { id: 'aaaaaaaa', role: 'master' },
            { id: 'bbbbbbbb', role: 'replica' },
          ],
        },
      ]);

      // The replica's OWN CLUSTER NODES reply carries the importing marker on its
      // myself line (source id must be hex for the parser to match).
      const replicaSelfView =
        'aaaaaaaa 10.0.0.1:6379@16379 master - 0 0 1 connected 0-16383\n' +
        'bbbbbbbb 10.0.0.2:6380@16380 myself,slave aaaaaaaa 0 0 1 connected [42-<-aaaaaaaa]';
      const nodeClient = { call: jest.fn().mockResolvedValue(replicaSelfView) };
      const getNodeConnection = jest.fn().mockResolvedValue(nodeClient);
      (service as any).clusterDiscovery = { getNodeConnection };

      await poll();
      expect(slotEvents()).toHaveLength(0); // within grace
      now += 31_000;
      await poll();
      const events = slotEvents();
      expect(events).toHaveLength(1);
      expect(events[0].message).toContain('IMPORTING');
      expect(getNodeConnection).toHaveBeenCalledWith('bbbbbbbb', 'conn-1');
    });

    // Shared stuck-replica fan-out fixture: primary view lists bbbbbbbb as a plain
    // replica (no node-local markers); the replica's own line carries IMPORTING.
    const stuckPrimaryView = [
      {
        id: 'aaaaaaaa',
        address: '10.0.0.1:6379@16379',
        flags: ['myself', 'master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [[0, 16383]],
      },
      {
        id: 'bbbbbbbb',
        address: '10.0.0.2:6380@16380',
        flags: ['slave'],
        master: 'aaaaaaaa',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
      },
    ];
    const stuckShards = [
      {
        slots: [[0, 16383]],
        nodes: [
          { id: 'aaaaaaaa', role: 'master' },
          { id: 'bbbbbbbb', role: 'replica' },
        ],
      },
    ];
    const stuckReplicaSelfView =
      'aaaaaaaa 10.0.0.1:6379@16379 master - 0 0 1 connected 0-16383\n' +
      'bbbbbbbb 10.0.0.2:6380@16380 myself,slave aaaaaaaa 0 0 1 connected [42-<-aaaaaaaa]';

    it('preserves a stuck replica WARNING when its self-view becomes unreachable (gap is not recovery)', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(stuckPrimaryView);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(stuckShards);
      const nodeClient = { call: jest.fn().mockResolvedValue(stuckReplicaSelfView) };
      (service as any).clusterDiscovery = {
        getNodeConnection: jest.fn().mockResolvedValue(nodeClient),
      };

      await poll();
      now += 31_000;
      await poll(); // fires the WARNING
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);

      // The replica becomes unreachable — its self-view now rejects. Its base
      // gossip line carries no markers, so the finding vanishes this poll.
      nodeClient.call.mockRejectedValue(new Error('blackholed'));
      const resolveCallsBefore = storage.resolveAnomaly.mock.calls.length;
      now += 5_000;
      await poll();

      // Observation gap, NOT recovery: the WARNING stays open and no resolve is
      // even attempted for the preserved signature.
      expect(slotEvents().filter((e) => !e.resolved)).toHaveLength(1);
      expect(storage.resolveAnomaly.mock.calls.length).toBe(resolveCallsBefore);
    });

    it('does not emit a duplicate when the tracked event is evicted but still unresolved in storage', async () => {
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(stuckPrimaryView);
      dbClient.getClusterShards = jest.fn().mockResolvedValue(stuckShards);
      const nodeClient = { call: jest.fn().mockResolvedValue(stuckReplicaSelfView) };
      (service as any).clusterDiscovery = {
        getNodeConnection: jest.fn().mockResolvedValue(nodeClient),
      };

      await poll();
      now += 31_000;
      await poll(); // fires E1
      const fired = slotEvents().filter((e) => !e.resolved);
      expect(fired).toHaveLength(1);
      const eventId = fired[0].id;

      // E1 is evicted from the 1000-cap in-memory ring but is still unresolved in
      // the storage-backed feed.
      (service as any).recentAnomalies = [];
      storage.getAnomalyEvents = jest.fn().mockResolvedValue([{ id: eventId, resolved: false }]);

      // Still stuck next poll: the dedupe must consult storage and reuse E1, not
      // emit a duplicate WARNING alongside the still-open stored row.
      now += 5_000;
      await poll();
      expect(storage.getAnomalyEvents).toHaveBeenCalledWith(
        expect.objectContaining({ resolved: false, connectionId: 'conn-1' }),
      );
      // No duplicate replica-slot event was emitted.
      expect(slotEvents()).toHaveLength(0);
    });
  });

  // ─── Orphaned slot keys detection (valkey-io/valkey#539) ───────────────────
  describe('orphaned slot keys detection (valkey#539)', () => {
    const clusterInfoResponse = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    // Single primary owning 0-100; SLOT-STATS reports only owned slot 50
    // (400 keys) while DBSIZE says 900 — a 500-key surplus no reported slot
    // accounts for (the real-server valkey#539 shape).
    const primaryNodes = [
      {
        id: 'primA',
        address: '10.0.0.1:6379@16379',
        flags: ['myself', 'master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [[0, 100]],
      },
    ];

    const ownedSlotStats = {
      '50': { key_count: 400, expires_count: 0, total_reads: 0, total_writes: 0 },
    };

    let now: number;

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterInfoResponse);
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({ cluster_state: 'ok' });
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(primaryNodes);
      dbClient.getCapabilities = jest
        .fn()
        .mockReturnValue({ hasClusterSlotStats: true } as ReturnType<
          DatabasePort['getCapabilities']
        >);
      dbClient.getClusterSlotStats = jest.fn().mockResolvedValue(ownedSlotStats);
      dbClient.getDbSize = jest.fn().mockResolvedValue(900);
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const orphanEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.ORPHANED_SLOT_KEYS);

    it('emits a WARNING once a dbsize surplus persists past the grace window', async () => {
      await poll();
      expect(orphanEvents()).toHaveLength(0);

      now += 31_000;
      await poll();

      const events = orphanEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('539');
    });

    it('fires under Raft (Cluster V2) too — a persistence-load leak is not a gossip race', async () => {
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({
        cluster_state: 'ok',
        cluster_raft_role: 'leader',
      });
      await poll();
      now += 31_000;
      await poll();
      expect(orphanEvents()).toHaveLength(1);
    });

    it('treats a failed DBSIZE as an observation gap, not recovery (no duplicate after blip)', async () => {
      await poll();
      now += 31_000;
      await poll(); // fires
      expect(orphanEvents()).toHaveLength(1);

      now += 16_000;
      (dbClient.getDbSize as jest.Mock).mockRejectedValue(new Error('DBSIZE failed'));
      await poll(); // observation gap — must not read as recovery

      (dbClient.getDbSize as jest.Mock).mockResolvedValue(900);
      now += 16_000;
      await poll(); // leak still present, must stay deduped
      now += 31_000;
      await poll(); // and must not re-fire after a fresh grace window either

      expect(orphanEvents()).toHaveLength(1);
    });

    it('preserves the persistence clock across a DBSIZE blip', async () => {
      await poll(); // t0: surplus observed, grace starts

      now += 16_000;
      (dbClient.getDbSize as jest.Mock).mockRejectedValue(new Error('DBSIZE failed'));
      await poll(); // gap — must not reset the clock

      (dbClient.getDbSize as jest.Mock).mockResolvedValue(900);
      now += 16_000; // t0 + 32s
      await poll();

      expect(orphanEvents()).toHaveLength(1);
    });

    it('probes at most once per probe interval, and skipping is a gap not recovery', async () => {
      await poll();
      now += 31_000;
      await poll(); // fires
      expect(orphanEvents()).toHaveLength(1);

      const statsCalls = (dbClient.getClusterSlotStats as jest.Mock).mock.calls.length;
      now += 1_000;
      await poll();
      now += 1_000;
      await poll();
      // Cheap polls inside the interval issue no SLOT-STATS/DBSIZE at all...
      expect((dbClient.getClusterSlotStats as jest.Mock).mock.calls).toHaveLength(statsCalls);
      // ...and must not resolve the active finding into a re-alert later.
      now += 31_000;
      await poll();
      expect(orphanEvents()).toHaveLength(1);
    });

    it('reads DBSIZE on both sides of SLOT-STATS', async () => {
      await poll();
      expect((dbClient.getDbSize as jest.Mock).mock.calls).toHaveLength(2);
    });

    it('does not fire on a draining keyspace whose dbsize falls between the reads', async () => {
      // A TTL cache draining under lazy+active expiry: keys counted by the
      // first DBSIZE are gone by the SLOT-STATS read. Taking the low-water
      // DBSIZE removes the positive bias — a single pre-read would leave a
      // 100-key surplus every poll and confirm a leak on a healthy cache.
      dbClient.getClusterSlotStats = jest.fn().mockResolvedValue({
        '50': { key_count: 900, expires_count: 0, total_reads: 0, total_writes: 0 },
      });
      const bracketed = [1_000, 850];
      let readIndex = 0;
      (dbClient.getDbSize as jest.Mock).mockImplementation(() => {
        const value = bracketed[readIndex % bracketed.length];
        readIndex += 1;
        return Promise.resolve(value);
      });

      const naiveSurplus = 1_000 - 900;
      expect(naiveSurplus).toBeGreaterThanOrEqual(100);

      await poll();
      now += 31_000;
      await poll();

      expect(orphanEvents()).toHaveLength(0);
    });

    it('re-alerts when the surplus genuinely clears and later recurs', async () => {
      await poll();
      now += 31_000;
      await poll(); // fires (1)

      (dbClient.getDbSize as jest.Mock).mockResolvedValue(400);
      now += 16_000;
      await poll(); // genuine recovery → clears grace + dedupe

      (dbClient.getDbSize as jest.Mock).mockResolvedValue(900);
      now += 16_000;
      await poll(); // recurs, fresh grace window → no alert yet
      now += 31_000;
      await poll(); // persisted again → fires (2)

      expect(orphanEvents()).toHaveLength(2);
    });
  });

  describe('raceWithTimeout', () => {
    it('rejects when the wrapped promise does not settle within the timeout', async () => {
      const svc = service as unknown as {
        raceWithTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T>;
      };
      await expect(
        svc.raceWithTimeout(new Promise(() => {}), 5, 'CLUSTER NODES timed out'),
      ).rejects.toThrow('CLUSTER NODES timed out');
    });

    it('resolves with the value when the promise settles first', async () => {
      const svc = service as unknown as {
        raceWithTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T>;
      };
      await expect(svc.raceWithTimeout(Promise.resolve('ok'), 10_000, 'boom')).resolves.toBe('ok');
    });
  });

  // ─── Connection limits (valkey-io/valkey#3918) ─────────────────────────────
  describe('rejected_connections unbundled from ACL_DENIED', () => {
    const infoWith = (rejected: string, aclDenied: string) => ({
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: rejected,
        acl_access_denied_auth: aclDenied,
      },
    });

    it('routes rejected_connections to its own delta metric and keeps ACL_DENIED auth-only', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('42', '7'));
      await poll(); // baseline poll → delta 0
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('50', '7'));
      await poll(); // 8 new refusals since last poll

      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      // Fed the per-poll DELTA (8), not the lifetime counter (50) — so a flat
      // elevated counter can't alert forever.
      expect(buffers.get(MetricType.REJECTED_CONNECTIONS).getLatest()).toBe(8);
      // ACL_DENIED must NOT include rejected connections (would be 57 if bundled).
      expect(buffers.get(MetricType.ACL_DENIED).getLatest()).toBe(7);
    });
  });

  // ─── Client-eviction storm (valkey-io/valkey#4151) ─────────────────────────
  describe('client-eviction storm detection', () => {
    const infoWith = (evicted: string, memClients = '1048576') => ({
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: {
        used_memory: '1000000',
        allocator_frag_ratio: '1.1',
        mem_clients_normal: memClients,
      },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        evicted_clients: evicted,
      },
    });
    const evictedEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.EVICTED_CLIENTS);

    beforeEach(() => {
      // Eviction enabled (a real byte limit), so the detector arms.
      dbClient.getConfigValue = jest.fn().mockResolvedValue('3145728');
    });

    it('feeds the per-poll delta and fires a CRITICAL on an eviction spike', async () => {
      // Prime a steady baseline (the buffer needs minSamples before it can alert).
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('5'));
      for (let i = 0; i < 30; i++) await poll(); // 30 samples of delta 0 → buffer ready
      expect(evictedEvents()).toHaveLength(0);

      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('20'));
      await poll(); // 15 new evictions since last poll (>= criticalThreshold 10)

      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.get(MetricType.EVICTED_CLIENTS).getLatest()).toBe(15); // delta, not 20
      const events = evictedEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('maxmemory-clients eviction');
      expect(events[0].message).toContain('valkey#4151');
    });

    it('does not arm when eviction is disabled (maxmemory-clients=0)', async () => {
      dbClient.getConfigValue = jest.fn().mockResolvedValue('0');
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('5'));
      await poll();
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('40'));
      await poll();

      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.has(MetricType.EVICTED_CLIENTS)).toBe(false);
      expect(evictedEvents()).toHaveLength(0);
    });

    it('does not false-fire when the counter resets on restart', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('100'));
      await poll(); // baseline at 100
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith('3')); // restart → counter back down
      await poll(); // max(0, 3-100) = 0, not a huge negative/positive spike

      const buffers: Map<MetricType, any> = (service as any).buffers.get('conn-1');
      expect(buffers.get(MetricType.EVICTED_CLIENTS).getLatest()).toBe(0);
      expect(evictedEvents()).toHaveLength(0);
    });
  });

  describe('client saturation detection', () => {
    const infoWith = (connected: number, maxclients: number | null = 100) => ({
      server: { role: 'master' },
      clients: {
        connected_clients: String(connected),
        blocked_clients: '0',
        ...(maxclients === null ? {} : { maxclients: String(maxclients) }),
      },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
      },
    });

    const satEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.CLIENT_SATURATION);

    it('does not alert below the warning threshold', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(70));
      await poll();
      expect(satEvents()).toHaveLength(0);
    });

    it('emits WARNING between 80% and 95%', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(85));
      await poll();
      const events = satEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('85/100');
    });

    it('emits CRITICAL at or above 95%', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(96));
      await poll();
      expect(satEvents()[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('deduplicates while steady, escalates warning→critical, and re-arms after recovery', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(85));
      await poll();
      await poll(); // steady warning → no repeat
      expect(satEvents()).toHaveLength(1);

      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(97));
      await poll(); // escalate → critical
      expect(satEvents()).toHaveLength(2);

      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(50));
      await poll(); // drop below warning → clears, no alert
      expect(satEvents()).toHaveLength(2);

      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(85));
      await poll(); // re-cross → new warning
      expect(satEvents()).toHaveLength(3);
    });

    it('does not divide by zero / alert when maxclients is absent', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(9999, null));
      await expect(poll()).resolves.not.toThrow();
      expect(satEvents()).toHaveLength(0);
    });

    it('re-alerts on the next poll when the escalation emit fails (level not advanced on failure)', async () => {
      let failSaturationEmit = true;
      const addSpy = jest
        .spyOn(service as any, 'addAnomaly')
        .mockImplementation(async (event: any) => {
          if (event.metricType === MetricType.CLIENT_SATURATION && failSaturationEmit) {
            failSaturationEmit = false;
            throw new Error('storage down');
          }
        });

      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(85));
      // Poll 1: escalation → emit fails → poll rejects, level must stay 'none'.
      await expect(poll()).rejects.toThrow('storage down');
      // Poll 2: still saturated → because the level was NOT advanced, it re-alerts.
      await poll();

      const saturationEmits = addSpy.mock.calls.filter(
        ([e]: [any]) => e.metricType === MetricType.CLIENT_SATURATION,
      );
      expect(saturationEmits).toHaveLength(2);
      addSpy.mockRestore();
    });
  });

  // ─── Config drift detection (valkey-io/valkey#1193) ────────────────────────
  describe('config drift detection', () => {
    function makeCtx(
      connectionId: string,
      opts: { role?: string; replid?: string; config: Record<string, string>; hasConfig?: boolean },
    ): ConnectionContext {
      const client: jest.Mocked<Partial<DatabasePort>> = {
        getInfoParsed: jest.fn().mockResolvedValue({
          server: { role: opts.role ?? 'master' },
          clients: { connected_clients: '10', blocked_clients: '0' },
          memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
          stats: {
            instantaneous_ops_per_sec: '100',
            instantaneous_input_kbps: '50',
            instantaneous_output_kbps: '30',
            evicted_keys: '0',
            keyspace_misses: '5',
            rejected_connections: '0',
            acl_access_denied_auth: '0',
          },
          replication: { master_replid: opts.replid ?? 'replid-shared' },
        }),
        getCapabilities: jest.fn().mockReturnValue({ hasConfig: opts.hasConfig ?? true }),
        // getConfigValues returns the parsed map; a key present with an empty
        // value (e.g. `save ""`) is preserved, an absent key yields no entry.
        getConfigValues: jest.fn((pattern: string) =>
          Promise.resolve(pattern in opts.config ? { [pattern]: opts.config[pattern] } : {}),
        ),
      };
      return {
        connectionId,
        connectionName: connectionId,
        client: client as any,
        host: 'localhost',
        port: 6379,
      };
    }

    const driftEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.CONFIG_DRIFT);

    // The curated allowlist is re-read only once per CONFIG_DRIFT_RECHECK_POLLS
    // polls. Tests that simulate observing a LATER config value (many minutes
    // apart in the field, adjacent polls here) must expire that countdown, or
    // the poll legitimately serves the cached snapshot.
    const expireConfigRecheck = (connectionId: string) => {
      (service as any).configDriftRecheck.set(connectionId, 0);
    };

    it('emits a WARNING when two same-group nodes disagree on a curated key', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-x', config: { maxmemory: '1000000' } });
      const ctxB = makeCtx('conn-b', { replid: 'replid-x', config: { maxmemory: '2000000' } });

      await poll(ctxA);
      await poll(ctxB);

      const events = driftEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('maxmemory');
      // Attributed to a real member of the drifting group, not whichever
      // connection's poll happened to run the scan.
      expect(['conn-a', 'conn-b']).toContain(events[0].connectionId);
    });

    it('does not alert when only one node of a group is monitored', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-solo', config: { maxmemory: '1000000' } });
      await poll(ctxA);
      expect(driftEvents()).toHaveLength(0);
    });

    it('does not alert across different groups even when values differ', async () => {
      const ctxA = makeCtx('conn-a', {
        replid: 'replid-group-1',
        config: { maxmemory: '1000000' },
      });
      const ctxB = makeCtx('conn-b', {
        replid: 'replid-group-2',
        config: { maxmemory: '2000000' },
      });
      await poll(ctxA);
      await poll(ctxB);
      expect(driftEvents()).toHaveLength(0);
    });

    it('does not alert when the group agrees on every curated key', async () => {
      const cfg = { maxmemory: '1000000', appendonly: 'yes' };
      const ctxA = makeCtx('conn-a', { replid: 'replid-agree', config: cfg });
      const ctxB = makeCtx('conn-b', { replid: 'replid-agree', config: cfg });
      await poll(ctxA);
      await poll(ctxB);
      expect(driftEvents()).toHaveLength(0);
    });

    it('deduplicates while the same mismatch persists across polls', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-y', config: { maxmemory: '1000000' } });
      const ctxB = makeCtx('conn-b', { replid: 'replid-y', config: { maxmemory: '2000000' } });
      await poll(ctxA);
      await poll(ctxB);
      await poll(ctxA);
      await poll(ctxB);
      expect(driftEvents()).toHaveLength(1);
    });

    it('re-reads the allowlist once per recheck window, not on every poll', async () => {
      const ctxA = makeCtx('conn-a', {
        replid: 'replid-throttle',
        config: { maxmemory: '1000000' },
      });
      const configGet = ctxA.client.getConfigValues as jest.Mock;

      await poll(ctxA);
      const afterFirstPoll = configGet.mock.calls.length;
      expect(afterFirstPoll).toBeGreaterThan(0);

      // Subsequent polls inside the window must not spend a single CONFIG GET.
      await poll(ctxA);
      await poll(ctxA);
      expect(configGet.mock.calls.length).toBe(afterFirstPoll);
    });

    it('still evaluates drift every poll while a peer fetch is throttled', async () => {
      // conn-a caches on its first poll; a peer registered afterwards must
      // still surface the mismatch against that cached snapshot immediately.
      const ctxA = makeCtx('conn-a', { replid: 'replid-cached', config: { maxmemory: '1000000' } });
      await poll(ctxA);
      await poll(ctxA);

      const ctxB = makeCtx('conn-b', { replid: 'replid-cached', config: { maxmemory: '2000000' } });
      await poll(ctxB);

      expect(driftEvents()).toHaveLength(1);
    });

    it('re-reads immediately when the replid changes rather than serving the cache', async () => {
      await poll(makeCtx('conn-a', { replid: 'replid-before', config: { maxmemory: '1000000' } }));

      // A failover moves the node to a new group: groupKey may only be rewritten
      // together with a fresh read, so the countdown must not suppress this one.
      const ctxAfter = makeCtx('conn-a', {
        replid: 'replid-after',
        config: { maxmemory: '1000000' },
      });
      await poll(ctxAfter);

      expect((ctxAfter.client.getConfigValues as jest.Mock).mock.calls.length).toBeGreaterThan(0);
      expect((service as any).configSnapshot.get('conn-a')?.groupKey).toBe('replid:replid-after');
    });

    it('re-arms after convergence and re-fires on a new mismatch', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-z', config: { maxmemory: '1000000' } });
      await poll(ctxA);
      await poll(makeCtx('conn-b', { replid: 'replid-z', config: { maxmemory: '2000000' } }));
      expect(driftEvents()).toHaveLength(1);

      // Converges — re-polling both while equal must clear the active signature.
      await poll(ctxA);
      expireConfigRecheck('conn-b');
      await poll(makeCtx('conn-b', { replid: 'replid-z', config: { maxmemory: '1000000' } }));
      expect(driftEvents()).toHaveLength(1); // still just the one from before, no new alert

      // Diverges again with a DIFFERENT value — must re-fire, not stay suppressed.
      await poll(ctxA);
      expireConfigRecheck('conn-b');
      await poll(makeCtx('conn-b', { replid: 'replid-z', config: { maxmemory: '3000000' } }));
      expect(driftEvents()).toHaveLength(2);
    });

    it('detects drift on an empty save value (RDB disabled on one node only)', async () => {
      // Regression: an empty `save ""` must be recorded and compared, not
      // dropped as if the key were unsupported.
      const ctxA = makeCtx('conn-a', { replid: 'replid-save', config: { save: '3600 1 300 100' } });
      const ctxB = makeCtx('conn-b', { replid: 'replid-save', config: { save: '' } });
      await poll(ctxA);
      await poll(ctxB);

      const events = driftEvents();
      expect(events).toHaveLength(1);
      expect(events[0].message).toContain('save');
    });

    it('keeps the last-known snapshot when a poll fails to read any config', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-blip', config: { maxmemory: '1000000' } });
      const ctxB = makeCtx('conn-b', { replid: 'replid-blip', config: { maxmemory: '2000000' } });
      await poll(ctxA);
      await poll(ctxB);
      expect(driftEvents()).toHaveLength(1);

      // conn-b hits a transient CONFIG GET failure → must NOT wipe its snapshot
      // (which would drop the drift and re-fire it once fetches recover).
      const ctxBFail = makeCtx('conn-b', {
        replid: 'replid-blip',
        config: { maxmemory: '2000000' },
      });
      (ctxBFail.client.getConfigValues as jest.Mock).mockRejectedValue(new Error('LOADING'));
      await poll(ctxBFail);

      expect((service as any).configSnapshot.get('conn-b')?.config).toEqual({
        maxmemory: '2000000',
      });
      // Still exactly one alert — the drift never spuriously cleared/re-fired.
      expect(driftEvents()).toHaveLength(1);
    });

    it('does not move a node to a new group on an all-keys-failed poll (stale replid during failover)', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-fo', config: { maxmemory: '1000000' } });
      const ctxB = makeCtx('conn-b', { replid: 'replid-fo', config: { maxmemory: '2000000' } });
      await poll(ctxA);
      await poll(ctxB);
      expect(driftEvents()).toHaveLength(1);

      // conn-b's replid changes (failover) AND every config read fails (LOADING).
      // The snapshot must keep its OLD groupKey rather than move conn-b onto
      // replid-new with stale config, which would clear/re-fire the drift.
      const ctxBFo = makeCtx('conn-b', { replid: 'replid-new', config: {} });
      (ctxBFo.client.getConfigValues as jest.Mock).mockRejectedValue(new Error('LOADING'));
      await poll(ctxBFo);

      expect((service as any).configSnapshot.get('conn-b')?.groupKey).toBe('replid:replid-fo');
      expect(driftEvents()).toHaveLength(1); // no new alert
    });

    it('retains a key whose fetch fails while other keys succeed (partial CONFIG GET failure)', async () => {
      const ctxA = makeCtx('conn-a', {
        replid: 'replid-partial',
        config: { maxmemory: '1000000' },
      });
      const ctxB = makeCtx('conn-b', {
        replid: 'replid-partial',
        config: { maxmemory: '2000000' },
      });
      await poll(ctxA);
      await poll(ctxB);
      expect(driftEvents()).toHaveLength(1);

      // conn-b: maxmemory fetch fails this poll but appendonly succeeds. The
      // drifted maxmemory must be retained from the prior snapshot (merge, not
      // replace) so the mismatch does NOT vanish and re-fire.
      const ctxBPartial = makeCtx('conn-b', {
        replid: 'replid-partial',
        config: { maxmemory: '2000000' },
      });
      (ctxBPartial.client.getConfigValues as jest.Mock).mockImplementation((pattern: string) =>
        pattern === 'maxmemory'
          ? Promise.reject(new Error('blip'))
          : Promise.resolve(pattern === 'appendonly' ? { appendonly: 'yes' } : {}),
      );
      expireConfigRecheck('conn-b');
      await poll(ctxBPartial);

      const snap = (service as any).configSnapshot.get('conn-b')?.config;
      expect(snap.maxmemory).toBe('2000000'); // retained despite this poll's failure
      expect(snap.appendonly).toBe('yes'); // freshly merged in
      expect(driftEvents()).toHaveLength(1); // drift never spuriously re-fired
    });

    it('attributes the drift event to the drifting node (telemetry + source), not the poller/unknown', async () => {
      (service as any).connectionRegistry.list.mockReturnValue([
        { id: 'conn-a', name: 'A', host: 'host-a', port: 7001 },
        { id: 'conn-b', name: 'B', host: 'host-b', port: 7002 },
      ]);
      (service as any).connectionRegistry.get.mockReturnValue({} as any);

      const ctxA = makeCtx('conn-a', { replid: 'replid-attr', config: { maxmemory: '1000000' } });
      const ctxB = makeCtx('conn-b', { replid: 'replid-attr', config: { maxmemory: '2000000' } });
      await poll(ctxA);
      await poll(ctxB);

      const event = driftEvents()[0];
      const attributed =
        event.connectionId === 'conn-a'
          ? { host: 'host-a', port: 7001 }
          : { host: 'host-b', port: 7002 };

      // Prometheus labelled with the attributed node id (not undefined/unknown).
      expect(prometheusService.incrementAnomalyEvent).toHaveBeenCalledWith(
        expect.anything(),
        MetricType.CONFIG_DRIFT,
        expect.anything(),
        event.connectionId,
      );
      // Stored event's source host/port reflect the attributed node, not the default.
      const storedCall = storage.saveAnomalyEvent.mock.calls.find(
        ([e]: any[]) => e.metricType === MetricType.CONFIG_DRIFT,
      );
      expect(storedCall?.[0].sourceHost).toBe(attributed.host);
      expect(storedCall?.[0].sourcePort).toBe(attributed.port);
    });

    it('skips connections without CONFIG support and does not record a snapshot for them', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-nc', config: {}, hasConfig: false });
      await poll(ctxA);
      expect((service as any).configSnapshot.has('conn-a')).toBe(false);
    });

    it('drops a removed connection from the shared snapshot so it cannot linger as a phantom drift source', async () => {
      const ctxA = makeCtx('conn-a', { replid: 'replid-w', config: { maxmemory: '1000000' } });
      const ctxB = makeCtx('conn-b', { replid: 'replid-w', config: { maxmemory: '2000000' } });
      await poll(ctxA);
      await poll(ctxB);
      expect((service as any).configSnapshot.has('conn-b')).toBe(true);

      (service as any).onConnectionRemoved('conn-b');
      expect((service as any).configSnapshot.has('conn-b')).toBe(false);
    });
  });

  // ─── Raft cluster health (Valkey Cluster V2) ───────────────────────────────
  describe('raft cluster health', () => {
    const clusterEnabledInfo = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    // CLUSTER INFO in Raft mode (field names verified against a live cluster-v2 build).
    const raftInfo = (over: Record<string, string> = {}) => ({
      cluster_state: 'ok',
      cluster_known_nodes: '3',
      cluster_size: '3',
      cluster_raft_role: 'follower',
      cluster_raft_current_term: '1',
      cluster_raft_commit_index: '9',
      cluster_raft_last_applied: '9',
      cluster_raft_log_entries: '9',
      cluster_raft_leader: '4adc1ba9b9a4dd2cdaad18f8f73f6bedc3bc4c7a',
      ...over,
    });

    let now: number;
    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterEnabledInfo);
      dbClient.getClusterNodes = jest.fn().mockResolvedValue([]);
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      // Leaderless windows scale with cluster-node-timeout: 15000ms → recovery
      // 45s (3x), fire 60s (recovery + one timeout).
      dbClient.getConfigValue = jest.fn().mockResolvedValue('15000');
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });
    afterEach(() => (Date.now as jest.Mock).mockRestore());

    const raftEvents = () =>
      service.getRecentEvents().filter((e) => e.metricType === MetricType.RAFT_HEALTH);

    it('emits nothing for a healthy raft cluster', async () => {
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      await poll();
      expect(raftEvents()).toHaveLength(0);
    });

    it('skips the gossip topology detectors in raft mode', async () => {
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo());
      dbClient.getClusterShards = jest.fn();
      await poll();
      // CLUSTER NODES is still fetched once (the topology-agnostic orphan
      // detector runs under Raft too), but CLUSTER SHARDS — fetched solely for
      // the gossip-era detectors — must not be, and no gossip topology events
      // may surface.
      expect(dbClient.getClusterShards).not.toHaveBeenCalled();
      expect(
        service.getRecentEvents().filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY),
      ).toHaveLength(0);
    });

    it('runs the gossip detectors in gossip mode (no raft fields)', async () => {
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue({ cluster_state: 'ok', cluster_size: '3', cluster_known_nodes: '3' });
      await poll();
      expect(dbClient.getClusterNodes).toHaveBeenCalled();
    });

    it('keeps skipping gossip detectors when CLUSTER INFO fails on a known-Raft connection', async () => {
      // Bugbot: once Raft mode is established, a transient getClusterInfo() failure
      // must not fall back to the gossip topology detectors (which call
      // getClusterNodes) — that would surface false #2261/#2090 alerts.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      dbClient.getClusterShards = jest.fn();
      await poll(); // establishes Raft mode
      expect(dbClient.getClusterShards).not.toHaveBeenCalled();

      (dbClient.getClusterInfo as jest.Mock).mockRejectedValue(new Error('CLUSTERDOWN'));
      await poll(); // CLUSTER INFO throws — must stay Raft, skip gossip detectors
      expect(dbClient.getClusterShards).not.toHaveBeenCalled();
      expect(
        service.getRecentEvents().filter((e) => e.metricType === MetricType.CLUSTER_TOPOLOGY),
      ).toHaveLength(0);
    });

    it('emits CRITICAL when the node keeps seeking a leader with no commit progress', async () => {
      // Regression: the majority-loss surface keeps cluster_state:"ok" with a
      // frozen commit index (verified live). The alert fires on sustained seeking
      // + frozen commit — NOT on cluster_state:fail.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_state: 'ok', cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0: watch opens, within grace → no alert
      expect(raftEvents()).toHaveLength(0);

      now += 61_000; // exceed the fire window (60s at node-timeout 15s); still seeking, frozen
      await poll();
      const events = raftEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('no reachable leader');
    });

    it('fires when the role oscillates follower↔pre-candidate with a frozen commit index', async () => {
      // During a real outage the role flaps between follower and pre-candidate;
      // each seek is within the recovery window (45s) of the last, so the watch
      // never counts as "settled" and persists across the follower phases.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0: watch opens, lastSeeking=t0
      now += 20_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'follower' }),
      );
      await poll(); // t0+20s follower: 20s since seek (< 45s), 20s watch (< 60s) → no alert
      expect(raftEvents()).toHaveLength(0);
      now += 20_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'pre-candidate' }),
      );
      await poll(); // t0+40s: re-seek within the recovery window, lastSeeking refreshed
      now += 21_000;
      // Fire happens on a seeking beat (still pre-candidate here): 61s watch >= 60s.
      await poll(); // t0+61s pre-candidate: 61s watch, actively seeking → CRITICAL
      expect(raftEvents()).toHaveLength(1);
      expect(raftEvents()[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('does not alert on a one-off election blip that settles (idle cluster)', async () => {
      // Bugbot #1: a transient pre-candidate that re-hears its leader on an idle
      // cluster (commit never advances, role never becomes leader) must settle and
      // clear — not fire a false CRITICAL once the fire window elapses.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0: one seek → watch opens
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'follower' }),
      );
      now += 46_000; // no further seeking for > the recovery window (45s) → settled
      await poll(); // watch closes, no alert
      now += 20_000; // now well past the 60s fire window, but the watch is closed
      await poll();
      expect(raftEvents()).toHaveLength(0);
    });

    it('scales the windows with cluster-node-timeout so slow flaps still fire', async () => {
      // Bugbot: a fixed recovery window could close between the seeks of a slow
      // flap. With node-timeout 20s the recovery window is 60s and the fire window
      // 80s, so an oscillation with ~40s gaps — which a fixed 25s window would have
      // dropped — still alerts.
      dbClient.getConfigValue = jest.fn().mockResolvedValue('20000');
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0: watch opens, node-timeout cached (20s → recovery 60s / fire 80s)
      now += 40_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'follower' }),
      );
      await poll(); // t0+40s follower: 40s since seek (< 60s recovery) → not settled
      expect(raftEvents()).toHaveLength(0);
      now += 41_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'pre-candidate' }),
      );
      await poll(); // t0+81s: still seeking, 81s watch (>= 80s fire) → CRITICAL
      expect(raftEvents()).toHaveLength(1);
      expect(raftEvents()[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('re-checks cluster-node-timeout on a backoff, not every poll, and picks it up when readable', async () => {
      // Review (Tier 1): an unreadable CONFIG must be neither hammered every poll
      // NOR pinned to the default forever — it's retried on a backoff and the real
      // value is adopted as soon as CONFIG becomes readable.
      const getCfg = jest
        .fn()
        .mockRejectedValueOnce(new Error('NOPERM'))
        .mockResolvedValue('20000');
      dbClient.getConfigValue = getCfg;
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      await poll(); // attempt 1 fails → backoff armed
      expect(getCfg).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) await poll(); // within backoff → not re-queried
      expect(getCfg).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 65; i++) await poll(); // drain the backoff → re-attempt succeeds, caches
      expect(getCfg).toHaveBeenCalledTimes(2);
      await poll(); // real value cached → no further CONFIG calls
      expect(getCfg).toHaveBeenCalledTimes(2);
    });

    it('still emits the first CRITICAL when storage is unavailable (no false "pinned")', async () => {
      // Bugbot: a getActiveRaftOutages storage failure must not suppress the first
      // alert — with nothing pinned in memory it still emits.
      storage.getAnomalyEvents.mockRejectedValue(new Error('db down'));
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll();
      now += 61_000;
      await poll(); // storage down, nothing pinned → must still fire
      expect(activeCriticalRaft()).toHaveLength(1);
    });

    const activeCriticalRaft = () =>
      raftEvents().filter((e) => e.severity === AnomalySeverity.CRITICAL && !e.resolved);

    it('re-emits the outage event if it is resolved while quorum is still lost', async () => {
      // Bugbot (High): resolving the banner must not un-pin the panel during a live
      // outage. The detector keeps a live CRITICAL event present until recovery, so
      // dismissing one re-emits a fresh one on the next poll.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // watch opens
      now += 61_000;
      await poll(); // fires E1
      expect(activeCriticalRaft()).toHaveLength(1);
      const e1 = activeCriticalRaft()[0].id;

      await service.resolveAnomaly(e1); // operator dismisses while quorum is still lost
      expect(activeCriticalRaft()).toHaveLength(0);

      now += 1_000;
      await poll(); // still leaderless → a fresh CRITICAL is emitted
      expect(activeCriticalRaft()).toHaveLength(1);
      expect(activeCriticalRaft()[0].id).not.toBe(e1);
    });

    it('re-pins on a follower beat after a dismiss (no green gap during the flap)', async () => {
      // Review: fire is gated on `seeking` to avoid a false CRITICAL after idle
      // recovery — but once the outage is confirmed, a dismiss that lands on a
      // follower beat must still re-pin immediately, not stay green until the next
      // seek. Re-emit is therefore also allowed while the outage is confirmed.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // watch opens (seeking)
      now += 61_000;
      await poll(); // fires E1, outage confirmed
      expect(activeCriticalRaft()).toHaveLength(1);
      const e1 = activeCriticalRaft()[0].id;

      await service.resolveAnomaly(e1); // dismiss
      expect(activeCriticalRaft()).toHaveLength(0);

      now += 1_000;
      // Role flaps to follower (NOT seeking) — the pin must still come back.
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'follower' }),
      );
      await poll();
      expect(activeCriticalRaft()).toHaveLength(1);
      expect(activeCriticalRaft()[0].id).not.toBe(e1);
    });

    it('auto-resolves the outage event when quorum is restored', async () => {
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // watch opens
      now += 61_000;
      await poll(); // fires
      expect(activeCriticalRaft()).toHaveLength(1);

      now += 1_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'leader' }),
      );
      await poll(); // a leader is elected → outage over → event auto-resolves
      expect(activeCriticalRaft()).toHaveLength(0);
    });

    it('retries the recovery auto-resolve after a storage blip (no stuck CRITICAL)', async () => {
      // Bugbot: if the resolve on recovery fails, the id must not be dropped —
      // otherwise the CRITICAL row stays active forever. It retries next poll.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll();
      now += 61_000;
      await poll(); // fires
      expect(activeCriticalRaft()).toHaveLength(1);

      storage.resolveAnomaly.mockResolvedValueOnce(false); // first resolve fails
      now += 1_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'leader' }),
      );
      await poll(); // recovered but resolve failed → still active, id kept
      expect(activeCriticalRaft()).toHaveLength(1);

      now += 1_000;
      await poll(); // still healthy → retry resolve → succeeds
      expect(activeCriticalRaft()).toHaveLength(0);
    });

    it('retries the auto-resolve on a FOLLOWER recovery after a storage blip (no stuck pin)', async () => {
      // Review (Tier 1): recovery via commit-progress (a different node became
      // leader, so this node recovers as a follower) deletes the watch state. If the
      // resolve then blips, subsequent plain-healthy-follower polls must still retry
      // it — previously only the leader-recovery path retried, stranding the pin.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(
          raftInfo({ cluster_raft_role: 'pre-candidate', cluster_raft_commit_index: '9' }),
        );
      await poll();
      now += 61_000;
      await poll(); // fires (pre-candidate)
      expect(activeCriticalRaft()).toHaveLength(1);

      storage.resolveAnomaly.mockResolvedValueOnce(false); // first resolve blips
      now += 1_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'follower', cluster_raft_commit_index: '20' }),
      );
      await poll(); // follower recovery via commit progress; resolve fails → flag kept, watch deleted
      expect(activeCriticalRaft()).toHaveLength(1);

      now += 1_000; // now a plain healthy follower, no watch state
      await poll(); // must still retry the resolve → succeeds
      expect(activeCriticalRaft()).toHaveLength(0);
    });

    it('does not fire after the node recovers into an idle follower (fire vs recovery clock)', async () => {
      // Review (Tier 1): the fire clock runs from watch-open (`since`) but recovery
      // from the last seek, so a node that sought for a while then quietly recovered
      // into an idle follower must NOT trip a false CRITICAL in the gap before the
      // watch settles. Fire is gated on the node still actively seeking.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0: watch opens, seeking
      now += 30_000;
      await poll(); // t30: still seeking, lastSeeking advances to t30
      // Recover quietly into an idle follower (stops seeking, commit frozen, not leader).
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'follower' }),
      );
      now += 31_000;
      await poll(); // t61: watch age 61s >= fireMs 60s, but NOT seeking → must not fire
      expect(activeCriticalRaft()).toHaveLength(0);
    });

    it('does not re-emit (orphan) when the outage event is evicted but still active in storage', async () => {
      // Bugbot: an evicted-but-active event must not trigger a duplicate emit — the
      // authoritative (storage-backed) feed still reports it, so the pin holds
      // without a new row.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll();
      now += 61_000;
      await poll(); // fires E1
      expect(activeCriticalRaft()).toHaveLength(1);
      const e1id = activeCriticalRaft()[0].id;

      // Simulate E1 evicted from the in-memory ring but still unresolved in storage.
      (service as unknown as { recentAnomalies: unknown[] }).recentAnomalies = [];
      storage.getAnomalyEvents.mockResolvedValue([
        {
          id: e1id,
          timestamp: now,
          metricType: 'raft_health',
          anomalyType: 'drop',
          severity: 'critical',
          value: 0,
          baseline: 1,
          stdDev: 0,
          zScore: 0,
          threshold: 0,
          message: 'live outage',
          resolved: false,
        },
      ]);
      now += 1_000;
      await poll(); // authoritative feed still has E1 → must NOT emit a duplicate
      expect(raftEvents().filter((e) => e.severity === AnomalySeverity.CRITICAL)).toHaveLength(0);
    });

    it('re-emits after a dismissed event is purged from the cache, outage still live', async () => {
      // Bugbot ("missed re-emit"): if the dismissed row is removed from the ring
      // (clearResolved), not just flagged resolved, the pin must still come back —
      // the authoritative feed reports none active, so a fresh CRITICAL is emitted.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll();
      now += 61_000;
      await poll(); // fires E1
      const e1 = activeCriticalRaft()[0].id;

      await service.resolveAnomaly(e1); // operator dismisses
      service.clearResolved(); // ...and the resolved row is purged from the ring
      expect(activeCriticalRaft()).toHaveLength(0);

      now += 1_000;
      await poll(); // outage persists, nothing active anywhere → re-emit
      expect(activeCriticalRaft()).toHaveLength(1);
      expect(activeCriticalRaft()[0].id).not.toBe(e1);
    });

    it('does not alert on a brief seek that recovers into a leader (healthy failover)', async () => {
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0: seeking, watch opens, within grace
      now += 4_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'leader', cluster_raft_current_term: '2' }),
      );
      await poll(); // became leader before the gate → watch closes
      expect(raftEvents()).toHaveLength(0);
    });

    it('closes the watch when a leader emerges and the commit index advances', async () => {
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(
          raftInfo({ cluster_raft_role: 'pre-candidate', cluster_raft_commit_index: '9' }),
        );
      await poll(); // watch opens at commit 9
      now += 4_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_role: 'follower', cluster_raft_commit_index: '12' }),
      );
      await poll(); // commit advanced 9→12 → quorum proven, watch closes
      now += 20_000; // long past the gate, but the watch is closed
      await poll();
      expect(raftEvents()).toHaveLength(0);
    });

    it('does not alert on an idle healthy follower (frozen commit, never seeking)', async () => {
      // A quiet cluster also has a frozen commit index; the frozen index alone
      // must not trip the alert — only seeking-without-progress does.
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'follower' }));
      await poll();
      now += 30_000;
      await poll();
      expect(raftEvents()).toHaveLength(0);
    });

    it('emits WARNING on election churn (repeated term advances)', async () => {
      const setTerm = (t: number) =>
        (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
          raftInfo({ cluster_raft_current_term: String(t) }),
        );
      setTerm(1);
      await poll(); // baseline
      now += 1000;
      setTerm(2);
      await poll(); // election #1
      now += 1000;
      setTerm(3);
      await poll(); // election #2
      now += 1000;
      setTerm(4);
      await poll(); // election #3 → churn
      const events = raftEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('flapping');
    });

    it('does not treat a single healthy failover (one term bump) as churn', async () => {
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_current_term: '1' }),
      );
      await poll();
      now += 1000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_current_term: '2', cluster_raft_role: 'leader' }),
      );
      await poll();
      expect(raftEvents()).toHaveLength(0);
    });

    it('a throwing churn/metric emit does not block quorum-loss detection', async () => {
      // Review: the churn block runs before the leaderless block; a metric-emit
      // failure must not propagate out of addAnomaly and skip quorum-loss detection.
      // Sustained churn keeps the churn WARNING firing (and its metric emit throwing)
      // every poll while the node is also seeking — the CRITICAL must still fire.
      (prometheusService.incrementAnomalyEvent as jest.Mock).mockImplementation(() => {
        throw new Error('metrics down');
      });
      for (let i = 1; i <= 65; i++) {
        (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
          raftInfo({ cluster_raft_role: 'pre-candidate', cluster_raft_current_term: String(i) }),
        );
        await poll();
        now += 1000;
      }
      expect(activeCriticalRaft()).toHaveLength(1);
    });
  });

  // ─── Failover churn, gossip mode (valkey#3996) ─────────────────────────────

  describe('failover churn detection (gossip mode)', () => {
    const clusterEnabledInfo = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    const shardNodes = (epoch: number, ownerId: string) => [
      {
        id: ownerId,
        address: '10.0.0.1:6379@16379',
        flags: ['master'],
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: epoch,
        linkState: 'connected',
        slots: [[0, 16383]],
      },
    ];

    let now: number;

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterEnabledInfo);
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({ cluster_state: 'ok' });
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(shardNodes(1, 'primA'));
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const churnEvents = () => {
      return service.getRecentEvents().filter((e) => e.metricType === MetricType.FAILOVER_CHURN);
    };

    const setShard = (epoch: number, ownerId: string) => {
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(shardNodes(epoch, ownerId));
    };

    it('does not fire on a single clean failover', async () => {
      setShard(1, 'primA');
      await poll();
      now += 5_000;
      setShard(2, 'primB');
      await poll();
      now += 5_000;
      await poll();
      expect(churnEvents()).toHaveLength(0);
    });

    it('emits WARNING when a shard re-elects three times inside the window', async () => {
      setShard(1, 'primA');
      await poll();
      now += 5_000;
      setShard(2, 'primB');
      await poll();
      now += 5_000;
      setShard(3, 'primA');
      await poll();
      now += 5_000;
      setShard(4, 'primB');
      await poll();
      const events = churnEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('valkey#3996');
      expect(events[0].message).toContain('single failover coordinator');
    });

    it('escalates to CRITICAL when churn continues into a second window', async () => {
      let epoch = 1;
      const owners = ['primA', 'primB'];
      for (let i = 0; i < 7; i++) {
        setShard(epoch, owners[epoch % 2]);
        await poll();
        epoch += 1;
        now += 10_000;
      }
      const severities = churnEvents().map((e) => e.severity);
      expect(severities).toContain(AnomalySeverity.WARNING);
      expect(severities).toContain(AnomalySeverity.CRITICAL);
    });

    it('carries window state across a CLUSTER NODES failure', async () => {
      setShard(1, 'primA');
      await poll();
      now += 5_000;
      setShard(2, 'primB');
      await poll();
      now += 5_000;
      setShard(3, 'primA');
      await poll();
      now += 5_000;
      // Persistent rejection so the poll's shared topology fetch fails and the
      // gossip detectors — churn included — skip this poll without resetting
      // their window state.
      (dbClient.getClusterNodes as jest.Mock).mockRejectedValue(new Error('probe failed'));
      await poll();
      expect(churnEvents()).toHaveLength(0);
      now += 5_000;
      setShard(4, 'primB');
      await poll();
      expect(churnEvents()).toHaveLength(1);
    });

    it('does not run in raft mode', async () => {
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({
        cluster_state: 'ok',
        cluster_raft_role: 'leader',
        cluster_raft_current_term: '1',
        cluster_raft_leader: 'x',
      });
      dbClient.getConfigValue = jest.fn().mockResolvedValue('15000');
      dbClient.getClusterShards = jest.fn();
      await poll();
      // Topology may still be fetched (orphan detection runs under Raft), but
      // the gossip-only SHARDS fetch and churn detection itself must not run.
      expect(dbClient.getClusterShards).not.toHaveBeenCalled();
      expect(churnEvents()).toHaveLength(0);
    });

    it('clears churn state on connection removal', async () => {
      setShard(1, 'primA');
      await poll();
      expect((service as any).failoverChurnState.has('conn-1')).toBe(true);
      (service as any).onConnectionRemoved('conn-1');
      expect((service as any).failoverChurnState.has('conn-1')).toBe(false);
    });
  });

  // ─── Replication output-buffer pressure (valkey#3963) ──────────────────────

  describe('COB pressure detection', () => {
    const MB = 1024 * 1024;
    const HARD = 256 * MB;
    const LIMIT_RAW = `normal 0 0 0 slave ${HARD} ${64 * MB} 60 pubsub 33554432 8388608 60`;

    const replicatedInfo = (over: Record<string, string> = {}) => ({
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1', mem_clients_slaves: '0' },
      replication: { connected_slaves: '1', sync_full: '1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        ...over,
      },
    });

    const replicaClient = (omem: number) => [
      {
        id: '77',
        addr: '10.0.0.5:6380',
        name: '',
        age: 100,
        idle: 0,
        flags: 'S',
        db: 0,
        sub: 0,
        psub: 0,
        multi: -1,
        qbuf: 0,
        qbufFree: 0,
        obl: 0,
        oll: 0,
        omem,
        events: 'rw',
        cmd: 'psync',
        user: 'default',
      },
    ];

    let now: number;

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(replicatedInfo());
      dbClient.getConfigValue = jest.fn().mockResolvedValue(LIMIT_RAW);
      dbClient.getClients = jest.fn().mockResolvedValue(replicaClient(0));
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const cobEvents = () => {
      return service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.REPL_BUFFER_PRESSURE);
    };

    it('emits WARNING when a replica buffer crosses 60% of the hard limit', async () => {
      (dbClient.getClients as jest.Mock).mockResolvedValue(replicaClient(HARD * 0.7));
      await poll();
      const events = cobEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('valkey#3963');
      expect(events[0].message).toContain('10.0.0.5:6380');
    });

    it('does not re-emit while pressure holds steady (hysteresis)', async () => {
      (dbClient.getClients as jest.Mock).mockResolvedValue(replicaClient(HARD * 0.7));
      await poll();
      now += 5_000;
      await poll();
      expect(cobEvents()).toHaveLength(1);
    });

    it('escalates to CRITICAL on a sync_full increment after pressure', async () => {
      (dbClient.getClients as jest.Mock).mockResolvedValue(replicaClient(HARD * 0.7));
      await poll();
      now += 5_000;
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue({
        ...replicatedInfo(),
        replication: { connected_slaves: '1', sync_full: '2' },
      });
      // the pressured replica's connection is gone — it was dropped and is resyncing
      (dbClient.getClients as jest.Mock).mockResolvedValue([]);
      await poll();
      const critical = cobEvents().filter((e) => e.severity === AnomalySeverity.CRITICAL);
      expect(critical).toHaveLength(1);
      expect(critical[0].message).toContain('resync');
    });

    it('updates the per-replica Prometheus ratio gauge each poll', async () => {
      (dbClient.getClients as jest.Mock).mockResolvedValue(replicaClient(HARD * 0.5));
      await poll();
      expect(prometheusService.updateReplBufferPressure).toHaveBeenCalledWith('conn-1', [
        { replica: '10.0.0.5:6380', ratio: 0.5 },
      ]);
    });

    it('makes no replica-related calls when there are no replicas and no state', async () => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue({
        ...replicatedInfo(),
        replication: { connected_slaves: '0', sync_full: '0' },
      });
      await poll();
      expect(dbClient.getClients).not.toHaveBeenCalled();
      expect(dbClient.getConfigValue).not.toHaveBeenCalled();
      expect(cobEvents()).toHaveLength(0);
    });

    it('survives CONFIG GET and CLIENT LIST failures without crashing the poll', async () => {
      (dbClient.getConfigValue as jest.Mock).mockRejectedValue(new Error('NOPERM'));
      (dbClient.getClients as jest.Mock).mockRejectedValue(new Error('NOPERM'));
      await expect(poll()).resolves.not.toThrow();
      expect(cobEvents()).toHaveLength(0);
    });

    it('drops COB state and clears gauges when the node is demoted', async () => {
      (dbClient.getClients as jest.Mock).mockResolvedValue(replicaClient(HARD * 0.7));
      await poll();
      expect((service as any).cobState.has('conn-1')).toBe(true);
      now += 5_000;
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue({
        ...replicatedInfo(),
        server: { role: 'slave' },
      });
      await poll();
      expect((service as any).cobState.has('conn-1')).toBe(false);
      expect((service as any).cobLastSyncFull.has('conn-1')).toBe(false);
      expect(prometheusService.updateReplBufferPressure).toHaveBeenLastCalledWith('conn-1', []);
    });

    it('publishes an empty gauge set when the limit is unlimited', async () => {
      (dbClient.getConfigValue as jest.Mock).mockResolvedValue(
        'normal 0 0 0 slave 0 0 0 pubsub 33554432 8388608 60',
      );
      (dbClient.getClients as jest.Mock).mockResolvedValue(replicaClient(HARD * 0.7));
      await poll();
      expect(prometheusService.updateReplBufferPressure).toHaveBeenCalledWith('conn-1', []);
      expect(cobEvents()).toHaveLength(0);
    });

    it('clears COB state and gauges on connection removal', async () => {
      await poll();
      expect((service as any).cobState.has('conn-1')).toBe(true);
      (service as any).onConnectionRemoved('conn-1');
      expect((service as any).cobState.has('conn-1')).toBe(false);
      expect((service as any).cobLastSyncFull.has('conn-1')).toBe(false);
      expect((service as any).cobLimitCache.has('conn-1')).toBe(false);
      expect(prometheusService.updateReplBufferPressure).toHaveBeenLastCalledWith('conn-1', []);
    });
  });

  // ─── Control-plane saturation (valkey#3927) ────────────────────────────────

  describe('control-plane saturation detection', () => {
    const saturatedInfo = (cpuTotal: number, over: Record<string, unknown> = {}) => ({
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.0' },
      replication: { connected_slaves: '3' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
      },
      cpu: { used_cpu_sys: String(cpuTotal / 2), used_cpu_user: String(cpuTotal / 2) },
      ...over,
    });

    let now: number;
    let cpuCounter: number;

    beforeEach(() => {
      now = 1_700_000_000_000;
      cpuCounter = 100;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const saturationEvents = () => {
      return service.getRecentEvents().filter((e) => {
        return (
          e.metricType === MetricType.CPU_UTILIZATION &&
          e.severity === AnomalySeverity.CRITICAL &&
          e.zScore === 0
        );
      });
    };

    // One poll, advancing the cumulative CPU counter by `cpuDeltaSec` over a
    // 10s interval: +9.5 → 95% utilization, +0.5 → 5%.
    const pollWith = async (cpuDeltaSec: number, slaves = '3') => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(
        saturatedInfo(cpuCounter, { replication: { connected_slaves: slaves } }),
      );
      await poll();
      cpuCounter += cpuDeltaSec;
      now += 10_000;
    };

    // Baseline poll + N saturated polls (95% each).
    const pollSaturated = async (polls: number, slaves = '3') => {
      for (let i = 0; i < polls; i++) {
        await pollWith(9.5, slaves);
      }
    };

    it('never fires on sustained high CPU without corroboration', async () => {
      await pollSaturated(8);
      expect(saturationEvents()).toHaveLength(0);
    });

    it('fires once per episode when a replica drop corroborates the saturated CPU', async () => {
      await pollSaturated(5);
      // replica count 3 → 1 (a mass drop) while CPU stays pinned
      await pollSaturated(2, '1');
      const events = saturationEvents();
      expect(events).toHaveLength(1);
      expect(events[0].message).toContain('valkey#3927');
      expect(events[0].threshold).toBe(90);
      // continued saturation + another drop does not re-fire within the episode
      await pollSaturated(2, '0');
      expect(saturationEvents()).toHaveLength(1);
    });

    it('does not fire when a single replica is removed under busy-but-healthy CPU', async () => {
      await pollSaturated(5);
      // maintenance: one replica taken out while the primary is merely busy
      await pollSaturated(3, '2');
      expect(saturationEvents()).toHaveLength(0);
    });

    it('corroborates from a recent control-plane anomaly event', async () => {
      await pollSaturated(4);
      (service as any).recentAnomalies.push({
        id: 'seed-repl-event',
        timestamp: now - 5_000,
        metricType: MetricType.REPLICATION_ROLE,
        anomalyType: AnomalyType.DROP,
        severity: AnomalySeverity.CRITICAL,
        value: 0,
        baseline: 1,
        zScore: 0,
        stdDev: 0,
        threshold: 0,
        message: 'failover',
        resolved: false,
        connectionId: 'conn-1',
      });
      await pollSaturated(1);
      expect(saturationEvents()).toHaveLength(1);
    });

    it('re-arms after CPU recovery and fires again on a new episode', async () => {
      await pollSaturated(5);
      await pollSaturated(1, '1');
      expect(saturationEvents()).toHaveLength(1);

      // recovery: one idle poll (5% CPU) resets the streak and the replicas rejoin
      await pollWith(0.5, '3');

      await pollSaturated(4, '3');
      await pollSaturated(1, '1');
      expect(saturationEvents()).toHaveLength(2);
    });

    it('does not pair a pre-restart streak with restart-driven replica loss', async () => {
      await pollSaturated(4);
      // server restart: counters go backwards and a replica drops in the same poll
      cpuCounter = 5;
      await pollWith(9.5, '1');
      expect(saturationEvents()).toHaveLength(0);
      // streak must rebuild from scratch after the restart
      await pollWith(9.5, '1');
      await pollWith(9.5, '1');
      expect(saturationEvents()).toHaveLength(0);
    });

    it('clears saturation state on connection removal', async () => {
      await pollSaturated(2);
      expect((service as any).controlPlaneState.has('conn-1')).toBe(true);
      (service as any).onConnectionRemoved('conn-1');
      expect((service as any).controlPlaneState.has('conn-1')).toBe(false);
      expect((service as any).cpSatLastConnectedSlaves.has('conn-1')).toBe(false);
    });
  });

  // ─── ghost membership: endpoint-identity faults (valkey#1757, valkey#2768) ──

  describe('ghost membership — endpoint identity', () => {
    const clusterInfoResponse = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    function gnode(id: string, address: string, flags: string[], master = ''): ClusterNode {
      return {
        id,
        address,
        flags,
        master,
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
      };
    }

    let now: number;

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterInfoResponse);
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({ cluster_state: 'ok' });
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const ghostEvents = () => {
      return service.getRecentEvents().filter((e) => {
        return e.metricType === MetricType.GHOST_MEMBERSHIP;
      });
    };

    /** Poll twice across the 30s grace window so a persistent finding alerts. */
    async function pollPastGate(): Promise<void> {
      await poll();
      now += 31_000;
      await poll();
    }

    it('emits CRITICAL for a node whose address flipped to loopback among routable peers', async () => {
      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('flippedAAAA', '127.0.0.1:6379@16379', ['master']),
          gnode('routableBBB', '10.0.0.2:6379@16379', ['myself', 'master']),
          gnode('routableCCC', '10.0.0.3:6379@16379', ['master']),
        ]);

      await pollPastGate();

      const events = ghostEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('2768');
      expect(events[0].message).toContain('cluster-announce-ip');
      expect(events[0].message).toContain('flipped');
    });

    it('emits WARNING for two live ids colliding on one routable endpoint', async () => {
      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('liveAAAAAAA', '10.0.0.1:6379@16379', ['master']),
          gnode('liveBBBBBBB', '10.0.0.1:6379@16379', ['master']),
          gnode('otherCCCCCC', '10.0.0.2:6379@16379', ['myself', 'master']),
        ]);

      await pollPastGate();

      const events = ghostEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('claimed by 2 live cluster nodes');
      expect(events[0].message).toContain('Do NOT run CLUSTER FORGET');
    });

    it('escalates a collision to CRITICAL when a node is replicating from itself', async () => {
      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('liveAAAAAAA', '10.0.0.1:6379@16379', ['master']),
          gnode('liveBBBBBBB', '10.0.0.1:6379@16379', ['slave'], 'liveBBBBBBB'),
          gnode('otherCCCCCC', '10.0.0.2:6379@16379', ['myself', 'master']),
        ]);

      await pollPastGate();

      const events = ghostEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.CRITICAL);
      expect(events[0].message).toContain('replica of');
    });

    it('escalates an already-alerted WARNING collision to CRITICAL when self-replication appears later', async () => {
      const collision = (masterOfB: string) => {
        return [
          gnode('liveAAAAAAA', '10.0.0.1:6379@16379', ['master']),
          gnode('liveBBBBBBB', '10.0.0.1:6379@16379', ['slave'], masterOfB),
          gnode('otherCCCCCC', '10.0.0.2:6379@16379', ['myself', 'master']),
        ];
      };

      dbClient.getClusterNodes = jest.fn().mockResolvedValue(collision('liveAAAAAAA'));
      await pollPastGate();

      const warned = ghostEvents();
      expect(warned).toHaveLength(1);
      expect(warned[0].severity).toBe(AnomalySeverity.WARNING);

      // The escalation carries a new signature, so it re-enters the persistence
      // gate and alerts on the poll after the grace window rather than instantly.
      dbClient.getClusterNodes = jest.fn().mockResolvedValue(collision('liveBBBBBBB'));
      now += 31_000;
      await poll();
      expect(ghostEvents()).toHaveLength(1);

      now += 31_000;
      await poll();

      const events = ghostEvents();
      expect(events).toHaveLength(2);
      const escalation = events.find((e) => {
        return e.severity === AnomalySeverity.CRITICAL;
      });
      expect(escalation).toBeDefined();
      expect(escalation?.message).toContain('replica of');
    });

    it('still emits the unchanged stale-twin WARNING with FORGET advice', async () => {
      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('oldGhostIdd', '10.0.0.1:6379@16379', ['master', 'fail']),
          gnode('newLiveIddd', '10.0.0.1:6379@16379', ['master']),
          gnode('otherCCCCCC', '10.0.0.2:6379@16379', ['myself', 'master']),
        ]);

      await pollPastGate();

      const events = ghostEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('CLUSTER FORGET oldGhostIdd');
      expect(events[0].message).toContain('1757');
    });

    it('suppresses a single-poll transient inside the grace window', async () => {
      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('flippedAAAA', '127.0.0.1:6379@16379', ['master']),
          gnode('routableBBB', '10.0.0.2:6379@16379', ['myself', 'master']),
        ]);
      await poll();
      expect(ghostEvents()).toHaveLength(0);

      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('flippedAAAA', '10.0.0.1:6379@16379', ['master']),
          gnode('routableBBB', '10.0.0.2:6379@16379', ['myself', 'master']),
        ]);
      now += 31_000;
      await poll();

      expect(ghostEvents()).toHaveLength(0);
    });

    it('stays silent on an all-loopback local cluster', async () => {
      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('localAAAAAA', '127.0.0.1:7000@17000', ['myself', 'master']),
          gnode('localBBBBBB', '127.0.0.1:7001@17001', ['master']),
          gnode('localCCCCCC', '127.0.0.1:7002@17002', ['slave'], 'localBBBBBB'),
        ]);

      await pollPastGate();

      expect(ghostEvents()).toHaveLength(0);
    });

    it('clears ghost state on connection removal', async () => {
      dbClient.getClusterNodes = jest
        .fn()
        .mockResolvedValue([
          gnode('flippedAAAA', '127.0.0.1:6379@16379', ['master']),
          gnode('routableBBB', '10.0.0.2:6379@16379', ['myself', 'master']),
        ]);
      await pollPastGate();
      expect((service as any).ghostMemberFirstSeen.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');

      expect((service as any).ghostMemberFirstSeen.has('conn-1')).toBe(false);
      expect((service as any).activeGhostMembers.has('conn-1')).toBe(false);
    });
  });

  // ─── ghost membership Layer 2: forget-rejoin (valkey#2788) ─────────────────

  describe('ghost membership — forget rejoin', () => {
    const clusterInfoResponse = {
      server: { role: 'master' },
      clients: { connected_clients: '10', blocked_clients: '0' },
      memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
      stats: {
        instantaneous_ops_per_sec: '100',
        instantaneous_input_kbps: '50',
        instantaneous_output_kbps: '30',
        evicted_keys: '0',
        keyspace_misses: '5',
        rejected_connections: '0',
        acl_access_denied_auth: '0',
        cluster_enabled: '1',
      },
    };

    function rnode(id: string, address: string, flags: string[]): ClusterNode {
      return {
        id,
        address,
        flags,
        master: '',
        pingSent: 0,
        pongReceived: 0,
        configEpoch: 1,
        linkState: 'connected',
        slots: [],
      };
    }

    const nodeA = rnode('primaryAAAA', '10.0.0.1:6379@16379', ['myself', 'master']);
    const nodeB = rnode('primaryBBBB', '10.0.0.2:6379@16379', ['master']);
    const nodeC = rnode('removedCCCC', '10.0.0.3:6379@16379', ['master']);

    let now: number;

    beforeEach(() => {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(clusterInfoResponse);
      dbClient.getClusterInfo = jest.fn().mockResolvedValue({ cluster_state: 'ok' });
      dbClient.getClusterNodes = jest.fn().mockResolvedValue([nodeA, nodeB, nodeC]);
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const rejoinEvents = () => {
      return service.getRecentEvents().filter((e) => {
        return (
          e.metricType === MetricType.GHOST_MEMBERSHIP && e.message.includes('reintroduced itself')
        );
      });
    };

    // Steps of 31s so a two-poll absence also clears the 60s FORGET blacklist
    // window the detector gates on.
    async function pollWith(nodes: ClusterNode[], stepMs = 31_000): Promise<void> {
      now += stepMs;
      (dbClient.getClusterNodes as jest.Mock).mockResolvedValue(nodes);
      await poll();
    }

    it('emits a WARNING when a forgotten node reintroduces itself', async () => {
      await pollWith([nodeA, nodeB, nodeC]);
      await pollWith([nodeA, nodeB]);
      await pollWith([nodeA, nodeB]);
      await pollWith([nodeA, nodeB, nodeC]);

      const events = rejoinEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('2788');
      expect(events[0].message).toContain('CLUSTER FORGET removedCCCC');
      expect(events[0].message).toContain('EVERY remaining node');
    });

    it('stays silent for a node that only flapped without leaving the view', async () => {
      await pollWith([nodeA, nodeB, nodeC]);
      await pollWith([
        nodeA,
        nodeB,
        rnode('removedCCCC', '10.0.0.3:6379@16379', ['master', 'fail']),
      ]);
      await pollWith([
        nodeA,
        nodeB,
        rnode('removedCCCC', '10.0.0.3:6379@16379', ['master', 'fail']),
      ]);
      await pollWith([nodeA, nodeB, nodeC]);

      expect(rejoinEvents()).toEqual([]);
    });

    it('stays silent for a genuinely new node joining the cluster', async () => {
      await pollWith([nodeA, nodeB]);
      await pollWith([nodeA, nodeB]);
      await pollWith([nodeA, nodeB, nodeC]);

      expect(rejoinEvents()).toEqual([]);
    });

    it('does not treat a failed CLUSTER NODES fetch as a mass departure', async () => {
      await pollWith([nodeA, nodeB, nodeC]);

      now += 10_000;
      (dbClient.getClusterNodes as jest.Mock).mockRejectedValue(new Error('CLUSTER NODES failed'));
      await poll();
      now += 10_000;
      (dbClient.getClusterNodes as jest.Mock).mockRejectedValue(new Error('CLUSTER NODES failed'));
      await poll();

      await pollWith([nodeA, nodeB, nodeC]);

      expect(rejoinEvents()).toEqual([]);
    });

    it('clears membership history on connection removal', async () => {
      await pollWith([nodeA, nodeB, nodeC]);
      expect((service as any).ghostHistories.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');

      expect((service as any).ghostHistories.has('conn-1')).toBe(false);
    });
  });

  // ─── connection exhaustion / admin lockout (valkey#3944) ───────────────────

  describe('client lockout risk', () => {
    function infoWith(overrides: Record<string, string>) {
      return {
        server: { role: 'master' },
        clients: {
          connected_clients: overrides.connected_clients ?? '100',
          blocked_clients: overrides.blocked_clients ?? '0',
          maxclients: overrides.maxclients ?? '1000',
        },
        memory: { used_memory: '1000000', allocator_frag_ratio: '1.1' },
        stats: {
          instantaneous_ops_per_sec: '100',
          instantaneous_input_kbps: '50',
          instantaneous_output_kbps: '30',
          evicted_keys: '0',
          keyspace_misses: '5',
          rejected_connections: overrides.rejected_connections ?? '0',
          acl_access_denied_auth: '0',
        },
      };
    }

    async function pollWith(overrides: Record<string, string>): Promise<void> {
      (dbClient.getInfoParsed as jest.Mock).mockResolvedValue(infoWith(overrides));
      await poll();
    }

    const lockoutEvents = () => {
      return service.getRecentEvents().filter((e) => {
        return e.metricType === MetricType.CLIENT_LOCKOUT_RISK;
      });
    };

    it('emits a WARNING only once the pressure is sustained', async () => {
      await pollWith({ connected_clients: '900' });
      await pollWith({ connected_clients: '900' });
      expect(lockoutEvents()).toHaveLength(0);

      await pollWith({ connected_clients: '900' });

      const events = lockoutEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('maxclients');
      expect(events[0].message).toContain('priority-net-sources');
    });

    it('emits CRITICAL when connections are refused against a sustained full pool', async () => {
      await pollWith({ connected_clients: '990', rejected_connections: '10' });
      await pollWith({ connected_clients: '1000', rejected_connections: '10' });
      await pollWith({ connected_clients: '1000', rejected_connections: '10' });
      await pollWith({ connected_clients: '1000', rejected_connections: '25' });

      const events = lockoutEvents();
      const critical = events.find((e) => {
        return e.severity === AnomalySeverity.CRITICAL;
      });
      expect(critical).toBeDefined();
      expect(critical?.message).toContain('turning connections away right now');
    });

    it('reports only WARNING when refusals arrive without sustained utilization', async () => {
      await pollWith({ connected_clients: '100', rejected_connections: '10' });
      await pollWith({ connected_clients: '120', rejected_connections: '25' });

      const events = lockoutEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
    });

    it('stays silent for a busy but sub-threshold pool', async () => {
      for (let i = 0; i < 6; i++) {
        await pollWith({ connected_clients: '700' });
      }
      expect(lockoutEvents()).toEqual([]);
    });

    it('clears lockout state on connection removal', async () => {
      await pollWith({ connected_clients: '900' });
      expect((service as any).clientLockoutState.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');

      expect((service as any).clientLockoutState.has('conn-1')).toBe(false);
    });
  });

  // ─── auth-failure burst from the audit store (valkey#334) ──────────────────

  describe('auth failure burst', () => {
    function aclRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 0,
        count: 20,
        reason: 'auth',
        context: 'toplevel',
        object: 'AUTH',
        username: 'default',
        ageSeconds: 1,
        clientInfo: 'id=7 addr=203.0.113.9:51234 laddr=10.0.0.1:6379 fd=8 name=',
        // Inside the 5-minute window, in ms, relative to the mocked clock.
        timestampCreated: 1_700_000_000_000 - 60_000,
        timestampLastUpdated: 1_700_000_000_000 - 30_000,
        capturedAt: 1_700_000_000,
        sourceHost: '10.0.0.1',
        sourcePort: 6379,
        connectionId: 'conn-1',
        ...overrides,
      };
    }

    let now: number;

    beforeEach(() => {
      now = 1_700_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      (Date.now as jest.Mock).mockRestore();
    });

    const authEvents = () => {
      return service.getRecentEvents().filter((e) => {
        return e.metricType === MetricType.AUTH_FAILURE_BURST;
      });
    };

    it('emits a WARNING naming the offending client address', async () => {
      storage.getAclEntries.mockResolvedValue([aclRow()]);
      await poll();

      const events = authEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('203.0.113.9');
      expect(events[0].value).toBe(20);
    });

    it('never leaks key names or raw client-info into the event', async () => {
      storage.getAclEntries.mockResolvedValue([
        aclRow({ reason: 'key', count: 5, object: 'secret:customer:pii' }),
        aclRow({ timestampCreated: 1_700_000_000_000 - 90_000, count: 20 }),
      ]);
      await poll();

      const [event] = authEvents();
      expect(event.message).not.toContain('secret:customer:pii');
      expect(event.message).not.toContain('laddr=');
      expect(event.message).not.toContain('fd=8');
    });

    it('queries the audit store windowed in seconds, not milliseconds', async () => {
      storage.getAclEntries.mockResolvedValue([]);
      await poll();

      expect(storage.getAclEntries).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'conn-1',
          startTime: Math.floor((now - 5 * 60 * 1000) / 1000),
        }),
      );
    });

    it('throttles the store scan rather than querying on every poll', async () => {
      storage.getAclEntries.mockResolvedValue([]);
      await poll();
      await poll();
      await poll();
      expect(storage.getAclEntries).toHaveBeenCalledTimes(1);

      now += 31_000;
      await poll();
      expect(storage.getAclEntries).toHaveBeenCalledTimes(2);
    });

    it('stays silent when the audit store has nothing (ACL LOG unavailable or audit off)', async () => {
      storage.getAclEntries.mockResolvedValue([]);
      await poll();
      expect(authEvents()).toEqual([]);
    });

    it('does not re-alert the same address on the next scan', async () => {
      storage.getAclEntries.mockResolvedValue([aclRow()]);
      await poll();
      now += 31_000;
      await poll();

      expect(authEvents()).toHaveLength(1);
    });

    it('survives a storage failure without breaking the poll', async () => {
      storage.getAclEntries.mockRejectedValue(new Error('storage down'));
      await expect(poll()).resolves.not.toThrow();
      expect(authEvents()).toEqual([]);
    });

    it('clears auth-failure state on connection removal', async () => {
      storage.getAclEntries.mockResolvedValue([aclRow()]);
      await poll();
      expect((service as any).authFailureState.has('conn-1')).toBe(true);

      (service as any).onConnectionRemoved('conn-1');

      expect((service as any).authFailureState.has('conn-1')).toBe(false);
      expect((service as any).authFailureLastScan.has('conn-1')).toBe(false);
    });
  });
});
