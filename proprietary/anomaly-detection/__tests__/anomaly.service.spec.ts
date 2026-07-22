import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AnomalyService } from '../anomaly.service';
import { PrometheusService } from '@app/prometheus/prometheus.service';
import { SettingsService } from '@app/settings/settings.service';
import { SlowLogAnalyticsService } from '@app/slowlog-analytics/slowlog-analytics.service';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ConnectionContext } from '@app/common/services/multi-connection-poller';
import { DatabasePort } from '@app/common/interfaces/database-port.interface';
import { MetricType, AnomalySeverity, AnomalyType } from '../types';
import { WEBHOOK_EVENTS_PRO_SERVICE, WebhookEventType } from '@betterdb/shared';
import { OtelEventDispatcherService } from '@app/otel-telemetry/otel-event-dispatcher.service';

describe('AnomalyService', () => {
  let service: AnomalyService;
  let slowLogAnalytics: { getLastSeenId: jest.Mock };
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

    storage = {
      saveAnomalyEvent: jest.fn().mockResolvedValue(undefined),
      saveCorrelatedGroup: jest.fn().mockResolvedValue(undefined),
      getAnomalyEvents: jest.fn().mockResolvedValue([]),
      getCorrelatedGroups: jest.fn().mockResolvedValue([]),
      resolveAnomaly: jest.fn().mockResolvedValue(true),
      initialize: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      isReady: jest.fn().mockReturnValue(true),
    };

    prometheusService = {
      incrementAnomalyEvent: jest.fn(),
      incrementCorrelatedGroup: jest.fn(),
      updateAnomalySummary: jest.fn(),
      updateAnomalyBufferStats: jest.fn(),
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
      const failoverEvents = events.filter(
        (e) => e.metricType === MetricType.REPLICATION_ROLE,
      );
      expect(failoverEvents).toHaveLength(0);
    });

    it('does not fire anomaly when role remains master', async () => {
      await poll(); // sets baseline to master
      await poll(); // still master
      const events = service.getRecentEvents();
      const failoverEvents = events.filter(
        (e) => e.metricType === MetricType.REPLICATION_ROLE,
      );
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
      const failoverEvents = events.filter(
        (e) => e.metricType === MetricType.REPLICATION_ROLE,
      );
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
      const failoverEvents = events.filter(
        (e) => e.metricType === MetricType.REPLICATION_ROLE,
      );
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
      const failoverEvents = events.filter(
        (e) => e.metricType === MetricType.REPLICATION_ROLE,
      );
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
      const failoverEvents = events.filter(
        (e) => e.metricType === MetricType.REPLICATION_ROLE,
      );
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
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(2000);

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
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(1000)
        .mockReturnValueOnce(2000);

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
        (m) => m !== MetricType.REPLICATION_ROLE && m !== MetricType.CLUSTER_STATE && m !== MetricType.DATASET_KEYS && m !== MetricType.COMMAND_P99 && m !== MetricType.PERSISTENCE_CHILD && m !== MetricType.CLUSTER_TOPOLOGY && m !== MetricType.SLOWLOG_LAST_ID && m !== MetricType.REJECTED_CONNECTIONS && m !== MetricType.CLIENT_SATURATION && m !== MetricType.RAFT_HEALTH && m !== MetricType.SLOWLOG_COUNT,
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
  });

  // ─── Data-Loss Detection (valkey/valkey#579) ─────────────────────────────

  describe('data-loss detection', () => {
    function mockReplInfo(opts: {
      role?: string;
      replid?: string;
      offset?: string;
      uptime?: string;
      connectedSlaves?: string;
      db0?: string;
      loading?: string;
      asyncLoading?: string;
    } = {}) {
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
        keyspace: opts.db0 !== undefined ? { db0: opts.db0 } : {},
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
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', offset: '5000', db0: 'keys=150,expires=0,avg_ttl=0' });
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
      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0', db0: 'keys=150,expires=0,avg_ttl=0' });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();
    });

    it('does not fire on a restart while the server is still loading its dataset from disk', async () => {
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', offset: '5000', db0: 'keys=150,expires=0,avg_ttl=0' });
      await poll();

      // Restarted with RDB/AOF: new replid and empty keyspace, but INFO reports
      // loading in progress — keys are not lost, just not loaded yet.
      mockReplInfo({ replid: 'replid-bbbb', uptime: '5', offset: '0', loading: '1' });
      await poll();

      expect(dataLossEvents()).toHaveLength(0);
      expect(webhookEventsProService.dispatchDataLossDetected).not.toHaveBeenCalled();

      // Load finishes and the keyspace is restored — still no false alert
      // because the transient empty snapshot was never recorded as baseline.
      mockReplInfo({ replid: 'replid-bbbb', uptime: '10', offset: '0', db0: 'keys=150,expires=0,avg_ttl=0' });
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
      mockReplInfo({ replid: 'replid-aaaa', uptime: '1000', offset: '5000', db0: 'keys=150,expires=0,avg_ttl=0' });
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
      expect(storage.resolveAnomaly).toHaveBeenCalledWith('persisted-but-not-cached', expect.any(Number));
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
      storage.saveAnomalyEvent.mockRejectedValueOnce(new Error('invalid input syntax for type uuid'));
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
  // InfoParser emits each keyspace db as a raw string ("keys=123,..."), but the
  // KeyspaceInfo type declares an object ({ keys, expires, avg_ttl }). The count
  // must be read off the typed INFO response (not the stringified flat record,
  // which would collapse an object to "[object Object]") and handle both shapes.
  describe('sumKeyspaceKeys', () => {
    const sum = (infoResponse: unknown): number =>
      (service as any).sumKeyspaceKeys(infoResponse);

    it('sums the string shape emitted by the real parser', () => {
      expect(
        sum({ keyspace: { db0: 'keys=150,expires=5,avg_ttl=0', db1: 'keys=42,expires=0,avg_ttl=0' } }),
      ).toBe(192);
    });

    it('sums the typed object shape declared by KeyspaceInfo', () => {
      expect(
        sum({ keyspace: { db0: { keys: 150, expires: 5, avg_ttl: 0 }, db1: { keys: 42, expires: 0, avg_ttl: 0 } } }),
      ).toBe(192);
    });

    it('ignores non-db keys and returns 0 for an empty or missing keyspace', () => {
      expect(sum({ keyspace: {} })).toBe(0);
      expect(sum({})).toBe(0);
      expect(sum({ keyspace: { note: 'keys=999' } })).toBe(0);
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
        undefined, undefined, undefined, MetricType.DATASET_KEYS, 100, undefined, true,
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
        undefined, undefined, undefined, MetricType.DATASET_KEYS, 100, undefined, true,
      );

      expect(storage.getAnomalyEvents).toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('in-mem');
    });

    it('dedupes by id when an event is both cached and persisted', async () => {
      storage.getAnomalyEvents.mockResolvedValue([oldOpenEvent]);
      (service as any).recentAnomalies = [{ ...oldOpenEvent, timestamp: Date.now() }];

      const events = await service.getRecentAnomalies(
        undefined, undefined, undefined, MetricType.DATASET_KEYS, 100, undefined, true,
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
        undefined, undefined, undefined, MetricType.DATASET_KEYS, 100, undefined, true,
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
      service
        .getRecentEvents()
        .filter((e) => e.metricType === MetricType.PERSISTENCE_CHILD);

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
      { id: 'a', address: '10.0.0.1:6379@16379', flags: ['myself', 'master'], master: '', pingSent: 0, pongReceived: 0, configEpoch: 1, linkState: 'connected', slots: [[0, 8191]] },
      { id: 'b', address: '10.0.0.2:6379@16379', flags: ['master'], master: '', pingSent: 0, pongReceived: 0, configEpoch: 2, linkState: 'connected', slots: [[8192, 16383]] },
    ];

    const splitBrainNodes = [
      { id: 'nodeAAAAAAAA', address: '10.0.0.1:6379@16379', flags: ['myself', 'master'], master: '', pingSent: 0, pongReceived: 0, configEpoch: 4, linkState: 'connected', slots: [[0, 5460]] },
      { id: 'nodeCCCCCCCC', address: '10.0.0.3:6379@16379', flags: ['master'], master: '', pingSent: 0, pongReceived: 0, configEpoch: 9, linkState: 'connected', slots: [[0, 5460]] },
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
      { id: 'primA', address: '10.0.0.1:6379@16379', flags: ['myself', 'master'], master: '', pingSent: 0, pongReceived: 0, configEpoch: 1, linkState: 'connected', slots: [[0, 16383]] },
      { id: 'repB', address: '10.0.0.2:6380@16380', flags: ['slave'], master: 'primA', pingSent: 0, pongReceived: 0, configEpoch: 1, linkState: 'connected', slots: [] },
    ];

    // valkey#2090: repB still replicates the dead old primary while a fresh
    // primary (newprim) took over the shard; repB never re-attaches.
    const orphanedNodes = [
      { id: 'newprim', address: '10.0.0.1:6379@16379', flags: ['master'], master: '', pingSent: 0, pongReceived: 0, configEpoch: 6, linkState: 'connected', slots: [[0, 16383]] },
      { id: 'repB', address: '10.0.0.2:6380@16380', flags: ['myself', 'slave'], master: 'deadprim', pingSent: 0, pongReceived: 0, configEpoch: 1, linkState: 'connected', slots: [] },
      { id: 'deadprim', address: ':0@0', flags: ['master', 'fail', 'noaddr'], master: '', pingSent: 0, pongReceived: 0, configEpoch: 1, linkState: 'disconnected', slots: [] },
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
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
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
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      await poll();
      expect(raftEvents()).toHaveLength(0);
    });

    it('skips the gossip topology detectors in raft mode', async () => {
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo());
      await poll();
      // detectDuplicatePrimaries / detectStuckReplicas both call getClusterNodes;
      // under Raft they must be skipped.
      expect(dbClient.getClusterNodes).not.toHaveBeenCalled();
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
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      await poll(); // establishes Raft mode
      expect(dbClient.getClusterNodes).not.toHaveBeenCalled();

      (dbClient.getClusterInfo as jest.Mock).mockRejectedValue(new Error('CLUSTERDOWN'));
      await poll(); // CLUSTER INFO throws — must stay Raft, skip gossip detectors
      expect(dbClient.getClusterNodes).not.toHaveBeenCalled();
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
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_role: 'follower' }));
      await poll(); // t0+20s follower: 20s since seek (< 45s), 20s watch (< 60s) → no alert
      expect(raftEvents()).toHaveLength(0);
      now += 20_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0+40s: re-seek within the recovery window, lastSeeking refreshed
      now += 21_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_role: 'follower' }));
      await poll(); // t0+61s follower: 21s since seek (not settled), 61s watch → CRITICAL
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
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_role: 'follower' }));
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
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_role: 'follower' }));
      await poll(); // t0+40s follower: 40s since seek (< 60s recovery) → not settled
      expect(raftEvents()).toHaveLength(0);
      now += 41_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // t0+81s: still seeking, 81s watch (>= 80s fire) → CRITICAL
      expect(raftEvents()).toHaveLength(1);
      expect(raftEvents()[0].severity).toBe(AnomalySeverity.CRITICAL);
    });

    it('retries cluster-node-timeout after a transient CONFIG failure (no permanent fallback)', async () => {
      // Bugbot: a thrown getConfigValue must not permanently pin the default —
      // it should be retried on the next poll until a real value is cached.
      const getCfg = jest
        .fn()
        .mockRejectedValueOnce(new Error('LOADING'))
        .mockResolvedValue('20000');
      dbClient.getConfigValue = getCfg;
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      await poll(); // attempt 1 throws → not cached
      await poll(); // attempt 2 succeeds → cached
      expect(getCfg).toHaveBeenCalledTimes(2);
      await poll(); // cached → no further CONFIG calls
      expect(getCfg).toHaveBeenCalledTimes(2);
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

    it('auto-resolves the outage event when quorum is restored', async () => {
      dbClient.getClusterInfo = jest
        .fn()
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
      await poll(); // watch opens
      now += 61_000;
      await poll(); // fires
      expect(activeCriticalRaft()).toHaveLength(1);

      now += 1_000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_role: 'leader' }));
      await poll(); // a leader is elected → outage over → event auto-resolves
      expect(activeCriticalRaft()).toHaveLength(0);
    });

    it('does not alert on a brief seek that recovers into a leader (healthy failover)', async () => {
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate' }));
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
        .mockResolvedValue(raftInfo({ cluster_raft_role: 'pre-candidate', cluster_raft_commit_index: '9' }));
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
      dbClient.getClusterInfo = jest.fn().mockResolvedValue(raftInfo({ cluster_raft_role: 'follower' }));
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
      setTerm(1); await poll(); // baseline
      now += 1000; setTerm(2); await poll(); // election #1
      now += 1000; setTerm(3); await poll(); // election #2
      now += 1000; setTerm(4); await poll(); // election #3 → churn
      const events = raftEvents();
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe(AnomalySeverity.WARNING);
      expect(events[0].message).toContain('flapping');
    });

    it('does not treat a single healthy failover (one term bump) as churn', async () => {
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(raftInfo({ cluster_raft_current_term: '1' }));
      await poll();
      now += 1000;
      (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
        raftInfo({ cluster_raft_current_term: '2', cluster_raft_role: 'leader' }),
      );
      await poll();
      expect(raftEvents()).toHaveLength(0);
    });

    it('retries the churn WARNING on the next poll when the first emit throws', async () => {
      // Bugbot: if addAnomaly throws on the churn fire path, the election must not
      // be dropped — the WARNING is retried on the next poll even without a new
      // term bump (the recorded elections stay in the window until a clean emit).
      const setTerm = (t: number) =>
        (dbClient.getClusterInfo as jest.Mock).mockResolvedValue(
          raftInfo({ cluster_raft_current_term: String(t) }),
        );
      // Throw on the emit that would fire the churn WARNING.
      (prometheusService.incrementAnomalyEvent as jest.Mock).mockImplementationOnce(() => {
        throw new Error('otel exporter down');
      });
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
      await poll(); // election #3 → fires, but the emit throws
      const callsAfterFailure = (prometheusService.incrementAnomalyEvent as jest.Mock).mock.calls.length;

      now += 1000; // no new election
      await poll(); // must retry the emit (recent elections still >= threshold)
      expect(
        (prometheusService.incrementAnomalyEvent as jest.Mock).mock.calls.length,
      ).toBeGreaterThan(callsAfterFailure);
    });
  });
});
