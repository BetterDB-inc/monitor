import { ConfigService } from '@nestjs/config';
import { PrometheusService } from '../../prometheus/prometheus.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import type { RuntimeCapabilityTracker } from '../../connections/runtime-capability-tracker.service';
import type { SlowLogAnalyticsService } from '../../slowlog-analytics/slowlog-analytics.service';
import type { CommandLogAnalyticsService } from '../../commandlog-analytics/commandlog-analytics.service';
import type { HealthService } from '../../health/health.service';
import type { StoragePort } from '../../common/interfaces/storage-port.interface';

export interface HarnessNode {
  id: string;
  host: string;
  port: number;
}

export const NODES: HarnessNode[] = [
  { id: 'conn-1', host: '10.0.0.1', port: 6379 },
  { id: 'conn-2', host: '10.0.0.2', port: 6380 },
];

export const ORPHAN_ID = 'conn-orphan';

function nodeInfo(): Record<string, unknown> {
  return {
    server: { valkey_version: '8.1.0', uptime_in_seconds: '100', os: 'Linux' },
    clients: { connected_clients: '5', blocked_clients: '0', tracking_clients: '0', maxclients: '10000' },
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
      aof_enabled: '0',
      aof_last_bgrewrite_status: 'ok',
    },
    replication: { role: 'master', connected_slaves: '0', master_repl_offset: '1234' },
    keyspace: { db0: { keys: 10, expires: 2, avg_ttl: 1500 } },
    cluster: { cluster_enabled: '0' },
  };
}

export function buildPrometheus(env: Record<string, unknown> = {}): {
  service: PrometheusService;
  registry: ConnectionRegistry;
} {
  const client = {
    getInfoParsed: jest.fn().mockResolvedValue(nodeInfo()),
    getClusterInfo: jest.fn().mockResolvedValue({}),
    getClusterNodes: jest.fn().mockResolvedValue([]),
    getCapabilities: jest.fn().mockReturnValue({ hasClusterSlotStats: false }),
    getClusterSlotStats: jest.fn().mockResolvedValue({}),
  };
  const byId = new Map(NODES.map((node) => [node.id, node]));
  const registry = {
    getConfig: jest.fn((id: string) => {
      const node = byId.get(id);
      return node ? { host: node.host, port: node.port } : null;
    }),
    get: jest.fn().mockReturnValue(client),
    list: jest.fn().mockReturnValue(
      NODES.map((node) => ({
        id: node.id,
        name: node.id,
        host: node.host,
        port: node.port,
        isConnected: true,
        capabilities: { dbType: 'valkey', version: '8.1.0' },
      })),
    ),
    getName: jest.fn((id: string) => id),
  } as unknown as ConnectionRegistry;
  const values: Record<string, unknown> = { PROMETHEUS_POLL_INTERVAL_MS: 5000, ...env };
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
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
  return { service, registry };
}

export async function pollAll(service: PrometheusService): Promise<void> {
  for (const id of [...NODES.map((node) => node.id), ORPHAN_ID]) {
    await service['runUpdateMetricsForConnection'](id);
  }
}
