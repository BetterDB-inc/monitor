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
        (m) => m !== MetricType.REPLICATION_ROLE && m !== MetricType.CLUSTER_STATE && m !== MetricType.SLOWLOG_LAST_ID && m !== MetricType.SLOWLOG_COUNT,
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

  // ─── Cluster State Webhook Dispatch ──────────────────────────────────────

  describe('cluster state webhook dispatch', () => {
    it('dispatches cluster.failover webhook on ok→fail transition', async () => {
      // First poll: establish cluster state as 'ok'
      dbClient.getInfoParsed.mockResolvedValue({
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
      dbClient.getClusterInfo.mockResolvedValue({
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
