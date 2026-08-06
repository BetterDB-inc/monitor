import type { ConnectionRegistry } from '../connections/connection-registry.service';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import type { InfoResponse } from '../common/types/metrics.types';
import { MetricsService } from './metrics.service';

function makeService(info: InfoResponse) {
  const client = { getInfoParsed: jest.fn().mockResolvedValue(info) };
  const registry = { get: jest.fn().mockReturnValue(client) } as unknown as ConnectionRegistry;
  const storage = {} as StoragePort;
  return new MetricsService(registry, storage);
}

const baseInfo: InfoResponse = {
  stats: { keyspace_hits: '90', keyspace_misses: '10' } as InfoResponse['stats'],
  memory: { mem_fragmentation_ratio: '1.25' } as InfoResponse['memory'],
  clients: { connected_clients: '4' } as InfoResponse['clients'],
  replication: { role: 'master' } as InfoResponse['replication'],
};

describe('MetricsService.getHealthSummary', () => {
  // Regression guard for issue #360: keyspace summation must work on the
  // parsed object shape produced by MetricsParser.parseInfoToTyped.
  it('sums keys across db entries in the keyspace section', async () => {
    const service = makeService({
      ...baseInfo,
      keyspace: {
        db0: { keys: 568, expires: 310, avg_ttl: 0 },
        db1: { keys: 32, expires: 0, avg_ttl: 0 },
      },
    });

    const summary = await service.getHealthSummary();

    expect(summary.keyspaceSize).toBe(600);
  });

  it('reports 0 when the keyspace section is present but empty', async () => {
    const service = makeService({ ...baseInfo, keyspace: {} });

    const summary = await service.getHealthSummary();

    expect(summary.keyspaceSize).toBe(0);
  });

  it('reports null when the keyspace section is absent', async () => {
    const service = makeService({ ...baseInfo });

    const summary = await service.getHealthSummary();

    expect(summary.keyspaceSize).toBeNull();
  });

  it('computes the remaining summary fields from scalar string sections', async () => {
    const service = makeService({
      ...baseInfo,
      keyspace: { db0: { keys: 1, expires: 0, avg_ttl: 0 } },
    });

    const summary = await service.getHealthSummary();

    expect(summary.hitRate).toBeCloseTo(0.9);
    expect(summary.memFragmentationRatio).toBeCloseTo(1.25);
    expect(summary.connectedClients).toBe(4);
    expect(summary.role).toBe('master');
    expect(summary.replicationLag).toBeNull();
  });

  it('reports replication lag for replicas', async () => {
    const service = makeService({
      ...baseInfo,
      replication: { role: 'slave', master_last_io_seconds_ago: '3' } as InfoResponse['replication'],
      keyspace: {},
    });

    const summary = await service.getHealthSummary();

    expect(summary.replicationLag).toBe(3);
  });
});
