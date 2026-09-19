import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

const LABEL = '10.0.0.1:6379';

function primaryInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server: { valkey_version: '8.1.0', uptime_in_seconds: '100', os: 'Linux' },
    clients: {
      connected_clients: '5',
      blocked_clients: '0',
      tracking_clients: '0',
      maxclients: '10000',
    },
    memory: {
      used_memory: '1000',
      used_memory_rss: '2000',
      used_memory_peak: '3000',
      maxmemory: '0',
      maxmemory_policy: 'noeviction',
      mem_fragmentation_ratio: '1.5',
      mem_fragmentation_bytes: '500',
    },
    stats: {
      total_connections_received: '10',
      total_commands_processed: '20',
      instantaneous_ops_per_sec: '3',
      instantaneous_input_kbps: '0.1',
      instantaneous_output_kbps: '0.2',
      keyspace_hits: '7',
      keyspace_misses: '1',
      evicted_keys: '0',
      expired_keys: '2',
      pubsub_channels: '0',
      pubsub_patterns: '0',
    },
    cpu: { used_cpu_sys: '1.5', used_cpu_user: '2.5' },
    persistence: {
      loading: '0',
      rdb_changes_since_last_save: '4',
      rdb_last_save_time: '1700000000',
      rdb_last_bgsave_status: 'ok',
      aof_enabled: '1',
      aof_last_bgrewrite_status: 'err',
    },
    replication: { role: 'master', connected_slaves: '1', master_repl_offset: '1234' },
    keyspace: {
      db0: { keys: 10, expires: 2, avg_ttl: 1000 },
      db3: { keys: 5, expires: 1, avg_ttl: 0 },
    },
    cluster: { cluster_enabled: '0' },
    ...overrides,
  };
}

const REPLICA_REPLICATION = {
  role: 'slave',
  master_link_status: 'up',
  master_last_io_seconds_ago: '1',
  slave_repl_offset: '1200',
};

function seriesFor(text: string, label: string = LABEL): string[] {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('#') && line.includes(`connection="${label}"`));
}

interface Harness {
  service: PrometheusService;
  client: {
    getInfoParsed: jest.Mock;
    getClusterInfo: jest.Mock;
    getClusterNodes: jest.Mock;
    getCapabilities: jest.Mock;
    getClusterSlotStats: jest.Mock;
  };
}

function buildService(env: Record<string, unknown> = {}): Harness {
  const client = {
    getInfoParsed: jest.fn().mockResolvedValue(primaryInfo()),
    getClusterInfo: jest.fn().mockResolvedValue({
      cluster_state: 'ok',
      cluster_known_nodes: '6',
      cluster_size: '3',
      cluster_slots_assigned: '16384',
      cluster_slots_ok: '16384',
      cluster_slots_fail: '0',
      cluster_slots_pfail: '0',
    }),
    getClusterNodes: jest.fn().mockResolvedValue([]),
    getCapabilities: jest.fn().mockReturnValue({ hasClusterSlotStats: true }),
    getClusterSlotStats: jest.fn().mockResolvedValue({}),
  };
  const registry = {
    getConfig: jest.fn().mockReturnValue({ host: '10.0.0.1', port: 6379 }),
    get: jest.fn().mockReturnValue(client),
    list: jest.fn().mockReturnValue([]),
    getName: jest.fn().mockReturnValue('primary'),
  } as unknown as ConnectionRegistry;
  const values: Record<string, unknown> = { PROMETHEUS_POLL_INTERVAL_MS: 5000, ...env };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
  } as unknown as ConfigService;
  const tracker = {
    isAvailable: jest.fn().mockReturnValue(true),
    recordFailure: jest.fn(),
  } as unknown as RuntimeCapabilityTracker;

  const service = new PrometheusService(
    {} as StoragePort,
    registry,
    config,
    tracker,
    {} as SlowLogAnalyticsService,
    {} as CommandLogAnalyticsService,
    {} as HealthService,
  );
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  return { service, client };
}

async function update(service: PrometheusService): Promise<void> {
  await service['runUpdateMetricsForConnection']('conn-1');
}

describe('PrometheusService vitals gauges', () => {
  it('exports keyspace totals summed across databases', async () => {
    const { service } = buildService();
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_keyspace_keys{connection="${LABEL}"} 15`);
    expect(text).toContain(`betterdb_keyspace_keys_expiring{connection="${LABEL}"} 3`);
  });

  it('exports zero keyspace totals for an empty keyspace', async () => {
    const { service, client } = buildService();
    client.getInfoParsed.mockResolvedValue(primaryInfo({ keyspace: {} }));
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_keyspace_keys{connection="${LABEL}"} 0`);
    expect(text).toContain(`betterdb_keyspace_keys_expiring{connection="${LABEL}"} 0`);
  });

  it('exports persistence state', async () => {
    const { service } = buildService();
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_rdb_changes_since_last_save{connection="${LABEL}"} 4`);
    expect(text).toContain(
      `betterdb_rdb_last_save_timestamp_seconds{connection="${LABEL}"} 1700000000`,
    );
    expect(text).toContain(`betterdb_rdb_last_bgsave_ok{connection="${LABEL}"} 1`);
    expect(text).toContain(`betterdb_aof_enabled{connection="${LABEL}"} 1`);
    expect(text).toContain(`betterdb_aof_last_bgrewrite_ok{connection="${LABEL}"} 0`);
  });

  it('keeps one instance_info series across a role change', async () => {
    const { service, client } = buildService();
    await update(service);
    client.getInfoParsed.mockResolvedValue(primaryInfo({ replication: REPLICA_REPLICATION }));
    await update(service);
    const text = await service.getMetrics();

    const info = seriesFor(text).filter((line) => line.startsWith('betterdb_instance_info'));
    expect(info).toHaveLength(1);
    expect(info[0]).toContain('role="slave"');
  });

  it('drops primary-only replication series after demotion', async () => {
    const { service, client } = buildService();
    await update(service);
    client.getInfoParsed.mockResolvedValue(primaryInfo({ replication: REPLICA_REPLICATION }));
    await update(service);
    const text = await service.getMetrics();

    expect(text).not.toContain(`betterdb_connected_slaves{connection="${LABEL}"}`);
    expect(text).toContain(`betterdb_master_link_up{connection="${LABEL}"} 1`);
  });

  it('drops replica-only replication series after promotion', async () => {
    const { service, client } = buildService();
    client.getInfoParsed.mockResolvedValue(primaryInfo({ replication: REPLICA_REPLICATION }));
    await update(service);
    client.getInfoParsed.mockResolvedValue(primaryInfo());
    await update(service);
    const text = await service.getMetrics();

    expect(text).not.toContain(`betterdb_master_link_up{connection="${LABEL}"}`);
    expect(text).not.toContain(`betterdb_master_last_io_seconds_ago{connection="${LABEL}"}`);
    expect(text).toContain(`betterdb_connected_slaves{connection="${LABEL}"} 1`);
  });
});

describe('PrometheusService export profiles', () => {
  const CLUSTER_INFO = { cluster_enabled: '1' };

  async function vitalsSeries(info: Record<string, unknown>): Promise<string[]> {
    const { service, client } = buildService({ METRICS_EXPORT_PROFILE: 'vitals' });
    client.getInfoParsed.mockResolvedValue(info);
    await update(service);
    return seriesFor(await service.getMetrics());
  }

  it('holds a standalone primary to 33 series', async () => {
    expect(await vitalsSeries(primaryInfo())).toHaveLength(33);
  });

  it('holds a standalone replica to 34 series', async () => {
    expect(
      await vitalsSeries(primaryInfo({ replication: REPLICA_REPLICATION })),
    ).toHaveLength(34);
  });

  it('holds a cluster primary to 39 series', async () => {
    expect(await vitalsSeries(primaryInfo({ cluster: CLUSTER_INFO }))).toHaveLength(39);
  });

  it('holds a cluster replica to 40 series', async () => {
    expect(
      await vitalsSeries(
        primaryInfo({ cluster: CLUSTER_INFO, replication: REPLICA_REPLICATION }),
      ),
    ).toHaveLength(40);
  });

  it('does not grow with the number of populated databases', async () => {
    const keyspace: Record<string, unknown> = {};
    for (let db = 0; db < 12; db++) {
      keyspace[`db${db}`] = { keys: db + 1, expires: 0, avg_ttl: 0 };
    }
    expect(await vitalsSeries(primaryInfo({ keyspace }))).toHaveLength(33);
  });

  it('leaves per-db, per-slot and pattern families out of the vitals scrape', async () => {
    const { service } = buildService({ METRICS_EXPORT_PROFILE: 'vitals' });
    await update(service);
    const text = await service.getMetrics();

    expect(text).not.toContain('# HELP betterdb_db_keys ');
    expect(text).not.toContain('# HELP betterdb_cluster_slot_keys ');
    expect(text).not.toContain('# HELP betterdb_slowlog_pattern_count ');
    expect(text).toContain('# HELP betterdb_memory_used_bytes ');
  });

  it('keeps every family under full', async () => {
    const { service } = buildService();
    await update(service);
    const text = await service.getMetrics();

    expect(text).toContain('# HELP betterdb_db_keys ');
    expect(text).toContain('# HELP betterdb_cluster_slot_keys ');
    expect(text).toContain('# HELP betterdb_slowlog_pattern_count ');
  });

  it('gives the OTLP mirror the same families as the scrape', async () => {
    const { service } = buildService({ METRICS_EXPORT_PROFILE: 'vitals' });
    await update(service);
    const text = await service.getMetrics();
    const scraped = new Set(
      text
        .split('\n')
        .filter((line) => line.startsWith('# HELP '))
        .map((line) => line.split(' ')[2]),
    );

    const mirrored = new Set((await service.collectMetricsAsJson()).map((m) => m.name));

    expect(mirrored).toEqual(scraped);
    expect(mirrored.has('betterdb_cluster_slot_keys')).toBe(false);
  });

  it('still removes a stale connection from the vitals scrape', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const { service, client } = buildService({ METRICS_EXPORT_PROFILE: 'vitals' });
      await update(service);
      client.getInfoParsed.mockRejectedValue(new Error('connection lost'));
      jest.advanceTimersByTime(5000 * 3 + 1);
      await update(service);
      const text = await service.getMetrics();

      expect(text).not.toContain(`betterdb_memory_used_bytes{connection="${LABEL}"}`);
      expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 1`);
    } finally {
      jest.useRealTimers();
    }
  });
});
