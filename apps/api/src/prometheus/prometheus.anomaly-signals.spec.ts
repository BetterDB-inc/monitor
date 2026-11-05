import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

const LABEL = '10.0.0.1:6379';
const OTHER_LABEL = '10.0.0.2:6379';
const SEED = '10.0.0.1:6379';
const SHARD = '10.0.0.5:6379';
const POLL_INTERVAL_MS = 5000;

const NO_REPLICATION = {
  replicas: [],
  writeRateBytesPerSecond: null,
  backlogCoverageSeconds: null,
};

describe('PrometheusService anomaly signal gauges', () => {
  let service: PrometheusService;
  let registry: ConnectionRegistry;

  function build(values: Record<string, unknown>): PrometheusService {
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    } as unknown as ConfigService;
    const built = new PrometheusService(
      {} as StoragePort,
      registry,
      config,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
    );
    jest.spyOn(built['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(built['logger'], 'warn').mockImplementation(() => undefined);
    return built;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    const configs: Record<string, { host: string; port: number }> = {
      'conn-1': { host: '10.0.0.1', port: 6379 },
      'conn-2': { host: '10.0.0.2', port: 6379 },
    };
    registry = {
      getConfig: jest.fn((id: string) => configs[id] ?? null),
      get: jest.fn().mockReturnValue({ getInfoParsed: jest.fn().mockResolvedValue({}) }),
      list: jest.fn().mockReturnValue([]),
      getDefaultId: jest.fn().mockReturnValue('conn-1'),
    } as unknown as ConnectionRegistry;
    service = build({ PROMETHEUS_POLL_INTERVAL_MS: POLL_INTERVAL_MS });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function series(name: string): Promise<Array<Record<string, string | number>>> {
    const { values } = await service['registry'].getSingleMetric(name)!.get();
    return values.map((v) => ({ ...v.labels, value: v.value }));
  }

  describe('updateReplicationSignals', () => {
    it('sets per-replica gap, lag and level plus the node write rate and coverage', async () => {
      service.updateReplicationSignals('conn-1', SEED, {
        replicas: [{ replica: '10.0.0.3:6379', gapBytes: 2048, secondsBehind: 1.5, level: 2 }],
        writeRateBytesPerSecond: 1000,
        backlogCoverageSeconds: 1048.576,
      });

      const text = await service.getMetrics();

      expect(text).toContain(
        `betterdb_replication_gap_bytes{connection="${LABEL}",node="${SEED}",replica="10.0.0.3:6379"} 2048`,
      );
      expect(text).toContain(
        `betterdb_replication_seconds_behind{connection="${LABEL}",node="${SEED}",replica="10.0.0.3:6379"} 1.5`,
      );
      expect(text).toContain(
        `betterdb_replication_divergence_level{connection="${LABEL}",node="${SEED}",replica="10.0.0.3:6379"} 2`,
      );
      expect(text).toContain(
        `betterdb_replication_write_rate_bytes_per_second{connection="${LABEL}",node="${SEED}"} 1000`,
      );
      expect(text).toContain(
        `betterdb_replication_backlog_coverage_seconds{connection="${LABEL}",node="${SEED}"} 1048.576`,
      );
    });

    it('omits series whose value is unknown', async () => {
      service.updateReplicationSignals('conn-1', SEED, {
        replicas: [{ replica: 'r1', gapBytes: null, secondsBehind: null, level: 1 }],
        writeRateBytesPerSecond: null,
        backlogCoverageSeconds: null,
      });

      expect(await series('betterdb_replication_divergence_level')).toEqual([
        { connection: LABEL, node: SEED, replica: 'r1', value: 1 },
      ]);
      expect(await series('betterdb_replication_gap_bytes')).toEqual([]);
      expect(await series('betterdb_replication_seconds_behind')).toEqual([]);
      expect(await series('betterdb_replication_write_rate_bytes_per_second')).toEqual([]);
      expect(await series('betterdb_replication_backlog_coverage_seconds')).toEqual([]);
    });

    it('removes a value that turns unknown on a later poll', async () => {
      service.updateReplicationSignals('conn-1', SEED, {
        replicas: [{ replica: 'r1', gapBytes: 10, secondsBehind: 2, level: 0 }],
        writeRateBytesPerSecond: 500,
        backlogCoverageSeconds: 30,
      });
      service.updateReplicationSignals('conn-1', SEED, {
        replicas: [{ replica: 'r1', gapBytes: 10, secondsBehind: null, level: 0 }],
        writeRateBytesPerSecond: 500,
        backlogCoverageSeconds: null,
      });

      expect(await series('betterdb_replication_seconds_behind')).toEqual([]);
      expect(await series('betterdb_replication_backlog_coverage_seconds')).toEqual([]);
      expect(await series('betterdb_replication_gap_bytes')).toHaveLength(1);
    });

    it('removes a replica that is no longer reported', async () => {
      service.updateReplicationSignals('conn-1', SEED, {
        ...NO_REPLICATION,
        replicas: [
          { replica: 'r1', gapBytes: 1, secondsBehind: 1, level: 0 },
          { replica: 'r2', gapBytes: 2, secondsBehind: 2, level: 1 },
        ],
      });
      service.updateReplicationSignals('conn-1', SEED, {
        ...NO_REPLICATION,
        replicas: [{ replica: 'r2', gapBytes: 3, secondsBehind: 3, level: 1 }],
      });

      for (const name of [
        'betterdb_replication_gap_bytes',
        'betterdb_replication_seconds_behind',
        'betterdb_replication_divergence_level',
      ]) {
        expect((await series(name)).map((s) => s.replica)).toEqual(['r2']);
      }
    });

    it('keeps other nodes of the same connection when one node pushes', async () => {
      service.updateReplicationSignals('conn-1', SEED, {
        replicas: [{ replica: 'r1', gapBytes: 1, secondsBehind: 1, level: 0 }],
        writeRateBytesPerSecond: 100,
        backlogCoverageSeconds: 10,
      });
      service.updateReplicationSignals('conn-1', SHARD, {
        replicas: [{ replica: 'r9', gapBytes: 9, secondsBehind: 9, level: 2 }],
        writeRateBytesPerSecond: 900,
        backlogCoverageSeconds: 90,
      });
      service.updateReplicationSignals('conn-1', SHARD, NO_REPLICATION);

      expect(await series('betterdb_replication_gap_bytes')).toEqual([
        { connection: LABEL, node: SEED, replica: 'r1', value: 1 },
      ]);
      expect(await series('betterdb_replication_write_rate_bytes_per_second')).toEqual([
        { connection: LABEL, node: SEED, value: 100 },
      ]);
    });

    it('ignores a connection that no longer exists', async () => {
      service.updateReplicationSignals('deleted', SEED, {
        replicas: [{ replica: 'r1', gapBytes: 1, secondsBehind: 1, level: 0 }],
        writeRateBytesPerSecond: 1,
        backlogCoverageSeconds: 1,
      });

      for (const name of [
        'betterdb_replication_gap_bytes',
        'betterdb_replication_seconds_behind',
        'betterdb_replication_divergence_level',
        'betterdb_replication_write_rate_bytes_per_second',
        'betterdb_replication_backlog_coverage_seconds',
      ]) {
        expect(await series(name)).toEqual([]);
      }
    });
  });

  describe('updateRetrySignals', () => {
    it('sets connects per second, churn per op and the retry state', async () => {
      service.updateRetrySignals('conn-1', SEED, {
        connectsPerSecond: 40,
        churnPerOp: 0.2,
        retryState: 2,
      });

      const text = await service.getMetrics();

      expect(text).toContain(
        `betterdb_connections_received_per_second{connection="${LABEL}",node="${SEED}"} 40`,
      );
      expect(text).toContain(
        `betterdb_connection_churn_per_op{connection="${LABEL}",node="${SEED}"} 0.2`,
      );
      expect(text).toContain(
        `betterdb_retry_amplification_state{connection="${LABEL}",node="${SEED}"} 2`,
      );
    });

    it('omits the rate series until a rate is known but always reports the state', async () => {
      service.updateRetrySignals('conn-1', SEED, {
        connectsPerSecond: null,
        churnPerOp: null,
        retryState: 0,
      });

      expect(await series('betterdb_connections_received_per_second')).toEqual([]);
      expect(await series('betterdb_connection_churn_per_op')).toEqual([]);
      expect(await series('betterdb_retry_amplification_state')).toEqual([
        { connection: LABEL, node: SEED, value: 0 },
      ]);
    });

    it('clears only the retry series of one node', async () => {
      service.updateRetrySignals('conn-1', SEED, {
        connectsPerSecond: 1,
        churnPerOp: 1,
        retryState: 1,
      });
      service.updateRetrySignals('conn-1', SHARD, {
        connectsPerSecond: 2,
        churnPerOp: 2,
        retryState: 2,
      });
      service.updateReplicationSignals('conn-1', SHARD, {
        ...NO_REPLICATION,
        writeRateBytesPerSecond: 5,
      });

      service.clearRetrySignals('conn-1', SHARD);

      expect(await series('betterdb_retry_amplification_state')).toEqual([
        { connection: LABEL, node: SEED, value: 1 },
      ]);
      expect(await series('betterdb_connections_received_per_second')).toEqual([
        { connection: LABEL, node: SEED, value: 1 },
      ]);
      expect(await series('betterdb_replication_write_rate_bytes_per_second')).toEqual([
        { connection: LABEL, node: SHARD, value: 5 },
      ]);
    });
  });

  describe('clearNodeSignals', () => {
    it('removes every series of a retired node and keeps the others', async () => {
      for (const node of [SEED, SHARD]) {
        service.updateReplicationSignals('conn-1', node, {
          replicas: [{ replica: `${node}-r`, gapBytes: 1, secondsBehind: 1, level: 1 }],
          writeRateBytesPerSecond: 10,
          backlogCoverageSeconds: 100,
        });
        service.updateRetrySignals('conn-1', node, {
          connectsPerSecond: 1,
          churnPerOp: 0.1,
          retryState: 1,
        });
      }

      service.clearNodeSignals('conn-1', SHARD);

      const text = await service.getMetrics();
      expect(text).not.toContain(`node="${SHARD}"`);
      expect(text).toContain(`betterdb_replication_gap_bytes{connection="${LABEL}",node="${SEED}"`);
      expect(text).toContain(
        `betterdb_retry_amplification_state{connection="${LABEL}",node="${SEED}"} 1`,
      );
    });

    it('does nothing for a node that never reported', async () => {
      service.updateRetrySignals('conn-1', SEED, {
        connectsPerSecond: 1,
        churnPerOp: 1,
        retryState: 0,
      });

      service.clearNodeSignals('conn-1', SHARD);
      service.clearNodeSignals('conn-2', SHARD);

      expect(await series('betterdb_retry_amplification_state')).toHaveLength(1);
    });
  });

  describe('updateActiveIncidents', () => {
    it('sets counts per pattern and status for every connection', async () => {
      service.updateActiveIncidents(
        new Map([
          [
            'conn-1',
            [
              { pattern: 'retry_storm', status: 'active', count: 2 },
              { pattern: 'none', status: 'recovering', count: 1 },
            ],
          ],
          ['conn-2', [{ pattern: 'retry_storm', status: 'degraded', count: 1 }]],
        ]),
      );

      const text = await service.getMetrics();

      expect(text).toContain(
        `betterdb_incident_active{connection="${LABEL}",pattern="retry_storm",status="active"} 2`,
      );
      expect(text).toContain(
        `betterdb_incident_active{connection="${LABEL}",pattern="none",status="recovering"} 1`,
      );
      expect(text).toContain(
        `betterdb_incident_active{connection="${OTHER_LABEL}",pattern="retry_storm",status="degraded"} 1`,
      );
    });

    it('removes a pattern and status that closed and clears connections left out', async () => {
      service.updateActiveIncidents(
        new Map([
          [
            'conn-1',
            [
              { pattern: 'retry_storm', status: 'active', count: 1 },
              { pattern: 'memory_pressure', status: 'active', count: 1 },
            ],
          ],
          ['conn-2', [{ pattern: 'retry_storm', status: 'active', count: 1 }]],
        ]),
      );
      service.updateActiveIncidents(
        new Map([['conn-1', [{ pattern: 'retry_storm', status: 'recovering', count: 1 }]]]),
      );

      expect(await series('betterdb_incident_active')).toEqual([
        { connection: LABEL, pattern: 'retry_storm', status: 'recovering', value: 1 },
      ]);
    });
  });

  describe('series lifecycle', () => {
    function pushEverything(connectionId: string): void {
      service.updateReplicationSignals(connectionId, SEED, {
        replicas: [{ replica: 'r1', gapBytes: 1, secondsBehind: 1, level: 1 }],
        writeRateBytesPerSecond: 10,
        backlogCoverageSeconds: 100,
      });
      service.updateRetrySignals(connectionId, SEED, {
        connectsPerSecond: 1,
        churnPerOp: 0.1,
        retryState: 1,
      });
      service.updateActiveIncidents(
        new Map([[connectionId, [{ pattern: 'none', status: 'active', count: 1 }]]]),
      );
    }

    it('drops every signal series when the connection is removed', async () => {
      await service['runUpdateMetricsForConnection']('conn-1');
      pushEverything('conn-1');
      expect(await service.getMetrics()).toContain(
        `betterdb_incident_active{connection="${LABEL}"`,
      );

      service.cleanupConnectionMetrics('conn-1');
      await jest.runAllTimersAsync();

      expect(await service.getMetrics()).not.toContain(`connection="${LABEL}"`);
    });

    it('drops push-only signal series when a never-polled connection is removed', async () => {
      pushEverything('conn-1');
      expect(await service.getMetrics()).toContain(
        `betterdb_retry_amplification_state{connection="${LABEL}"`,
      );

      service.cleanupConnectionMetrics('conn-1');
      await jest.runAllTimersAsync();

      expect(await service.getMetrics()).not.toContain(`connection="${LABEL}"`);
    });

    it('drops signal series once the connection goes stale', async () => {
      await service['runUpdateMetricsForConnection']('conn-1');
      pushEverything('conn-1');

      jest.advanceTimersByTime(POLL_INTERVAL_MS * 3 + 1);
      const text = await service.getMetrics();

      for (const name of [
        'betterdb_replication_gap_bytes',
        'betterdb_replication_divergence_level',
        'betterdb_replication_write_rate_bytes_per_second',
        'betterdb_retry_amplification_state',
        'betterdb_incident_active',
      ]) {
        expect(text).not.toContain(`${name}{connection="${LABEL}"`);
      }
    });

    it('is not exported under the vitals profile', async () => {
      const vitals = build({ METRICS_EXPORT_PROFILE: 'vitals' });
      vitals.updateRetrySignals('conn-1', SEED, {
        connectsPerSecond: 1,
        churnPerOp: 1,
        retryState: 1,
      });

      expect(await vitals.getMetrics()).not.toContain('betterdb_retry_amplification_state');
    });
  });
});
