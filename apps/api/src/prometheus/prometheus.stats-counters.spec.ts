import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { isExportedInProfile } from './export-profile';

const LABEL = '10.0.0.1:6379';

const FULL_STATS = {
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
  rejected_connections: '12',
  sync_full: '3',
  sync_partial_ok: '5',
  sync_partial_err: '2',
  total_net_input_bytes: '123456',
  total_net_output_bytes: '654321',
  total_error_replies: '42',
};

function info(stats: Record<string, string>): Record<string, unknown> {
  return {
    server: { valkey_version: '8.1.0', uptime_in_seconds: '100', os: 'Linux' },
    stats,
    replication: { role: 'master', connected_slaves: '0', master_repl_offset: '0' },
  };
}

function buildService(
  stats: Record<string, string>,
  connectionType: 'direct' | 'external' = 'direct',
): { service: PrometheusService; client: { getInfoParsed: jest.Mock } } {
  const client = {
    getInfoParsed: jest.fn().mockResolvedValue(info(stats)),
    getClusterInfo: jest.fn().mockResolvedValue({}),
    getClusterNodes: jest.fn().mockResolvedValue([]),
    getCapabilities: jest.fn().mockReturnValue({}),
    getClusterSlotStats: jest.fn().mockResolvedValue({}),
  };
  const registry = {
    getConfig: jest.fn().mockReturnValue({ host: '10.0.0.1', port: 6379, connectionType }),
    get: jest.fn().mockReturnValue(client),
    list: jest.fn().mockReturnValue([]),
    getName: jest.fn().mockReturnValue('primary'),
  } as unknown as ConnectionRegistry;
  const config = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService;
  const tracker = { isAvailable: jest.fn().mockReturnValue(true), recordFailure: jest.fn() };
  const service = new PrometheusService(
    {} as StoragePort,
    registry,
    config,
    tracker as unknown as RuntimeCapabilityTracker,
    {} as SlowLogAnalyticsService,
    {} as CommandLogAnalyticsService,
    {} as HealthService,
  );
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  return { service, client };
}

async function scrape(service: PrometheusService): Promise<string> {
  await service['runUpdateMetricsForConnection']('conn-1');
  return service.getMetrics();
}

function line(name: string, value: number | string): string {
  return `betterdb_${name}{connection="${LABEL}"} ${value}`;
}

describe('PrometheusService INFO stats counters', () => {
  it('exports rejected connections, resyncs, network bytes and error replies', async () => {
    const { service } = buildService(FULL_STATS);
    const text = await scrape(service);

    expect(text).toContain(line('rejected_connections_total', 12));
    expect(text).toContain(line('sync_full_total', 3));
    expect(text).toContain(line('sync_partial_ok_total', 5));
    expect(text).toContain(line('sync_partial_err_total', 2));
    expect(text).toContain(line('net_input_bytes_total', 123456));
    expect(text).toContain(line('net_output_bytes_total', 654321));
    expect(text).toContain(line('error_replies_total', 42));
  });

  it('follows the counters across polls', async () => {
    const { service, client } = buildService(FULL_STATS);
    await scrape(service);
    client.getInfoParsed.mockResolvedValue(
      info({ ...FULL_STATS, rejected_connections: '20', sync_full: '4' }),
    );
    const text = await scrape(service);

    expect(text).toContain(line('rejected_connections_total', 20));
    expect(text).toContain(line('sync_full_total', 4));
  });

  it('omits error replies on a server that predates total_error_replies', async () => {
    const { total_error_replies: _omitted, ...pre62 } = FULL_STATS;
    const { service } = buildService(pre62);
    const text = await scrape(service);

    expect(text).not.toContain(`betterdb_error_replies_total{connection="${LABEL}"}`);
    expect(text).toContain(line('rejected_connections_total', 12));
  });

  it('drops error replies when a later poll stops reporting the field', async () => {
    const { service, client } = buildService(FULL_STATS);
    await scrape(service);
    const { total_error_replies: _omitted, ...withoutErrors } = FULL_STATS;
    client.getInfoParsed.mockResolvedValue(info(withoutErrors));
    const text = await scrape(service);

    expect(text).not.toContain(`betterdb_error_replies_total{connection="${LABEL}"}`);
  });

  it('reports absent counters as 0 on a live connection, like the other INFO stats', async () => {
    const { service } = buildService({
      total_connections_received: '10',
      total_commands_processed: '20',
    });
    const text = await scrape(service);

    expect(text).toContain(line('rejected_connections_total', 0));
    expect(text).toContain(line('sync_full_total', 0));
    expect(text).toContain(line('net_input_bytes_total', 0));
  });

  it('exports only the counters an external (OTLP push) connection reports', async () => {
    const { service } = buildService(
      {
        total_connections_received: '10',
        rejected_connections: '7',
        total_net_input_bytes: '100',
        total_net_output_bytes: '200',
      },
      'external',
    );
    const text = await scrape(service);

    expect(text).toContain(line('rejected_connections_total', 7));
    expect(text).toContain(line('net_input_bytes_total', 100));
    expect(text).toContain(line('net_output_bytes_total', 200));
    expect(text).not.toContain(`betterdb_sync_full_total{connection="${LABEL}"}`);
    expect(text).not.toContain(`betterdb_error_replies_total{connection="${LABEL}"}`);
  });

  it('keeps the new counters out of the vitals profile', async () => {
    for (const name of [
      'betterdb_rejected_connections_total',
      'betterdb_sync_full_total',
      'betterdb_sync_partial_ok_total',
      'betterdb_sync_partial_err_total',
      'betterdb_net_input_bytes_total',
      'betterdb_net_output_bytes_total',
      'betterdb_error_replies_total',
    ]) {
      expect(isExportedInProfile(name, 'vitals')).toBe(false);
      expect(isExportedInProfile(name, 'full')).toBe(true);
    }
  });
});
