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
import { WEBHOOK_EVENTS_PRO_SERVICE } from '@betterdb/shared';

describe('AnomalyService', () => {
  let service: AnomalyService;
  let slowLogAnalytics: { getLastSeenId: jest.Mock };
  let storage: Record<string, jest.Mock>;
  let prometheusService: Record<string, jest.Mock>;
  let webhookEventsProService: Record<string, jest.Mock>;
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
            get: jest.fn().mockReturnValue('localhost'),
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
        (m) => m !== MetricType.REPLICATION_ROLE && m !== MetricType.CLUSTER_STATE && m !== MetricType.DATASET_KEYS && m !== MetricType.SLOWLOG_LAST_ID && m !== MetricType.SLOWLOG_COUNT,
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
      const a1 = { id: 'a1', resolved: false } as any;
      const a2 = { id: 'a2', resolved: false } as any;
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
      const a1 = { id: 'a1', resolved: false } as any;
      const a2 = { id: 'a2', resolved: false } as any;
      (service as any).recentGroups = [{ correlationId: 'grp-2', anomalies: [a1, a2] }];

      expect(await service.resolveGroup('grp-2')).toBe(false);
      expect(a1.resolved).toBe(true); // durable → cache flipped
      expect(a2.resolved).toBe(false); // failed → left unresolved
    });

    it('resolveGroup returns false when storage reports no row updated', async () => {
      storage.resolveAnomaly.mockResolvedValue(false);
      const a1 = { id: 'a1', resolved: false } as any;
      (service as any).recentGroups = [{ correlationId: 'grp-3', anomalies: [a1] }];

      expect(await service.resolveGroup('grp-3')).toBe(false);
      expect(a1.resolved).toBe(false);
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
  });
});
