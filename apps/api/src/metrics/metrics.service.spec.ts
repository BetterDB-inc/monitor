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

describe('MetricsService.getClusterNodes', () => {
  const clusterNodes = [
    {
      id: 'primary-1',
      address: '10.0.0.1:6379',
      flags: ['master'],
      master: '-',
      pingSent: 0,
      pongReceived: 0,
      configEpoch: 1,
      linkState: 'connected',
      slots: [[0, 16383]],
    },
  ];

  function makeClusterService(getClusterShards: jest.Mock, zones?: Record<string, string>) {
    const client = { getClusterNodes: jest.fn().mockResolvedValue(clusterNodes), getClusterShards };
    const registry = {
      get: jest.fn().mockReturnValue(client),
      getDefaultId: jest.fn().mockReturnValue(null),
      getNodeAvailabilityZones: jest.fn().mockReturnValue(zones),
    } as unknown as ConnectionRegistry;
    return { service: new MetricsService(registry, {} as StoragePort), registry };
  }

  it('adds the availability zone and shard id from CLUSTER SHARDS', async () => {
    const { service } = makeClusterService(
      jest.fn().mockResolvedValue([
        {
          shardId: 'shard-1',
          slots: [[0, 16383]],
          nodes: [{ id: 'primary-1', role: 'master', availabilityZone: 'us-east-1a' }],
        },
      ]),
    );

    await expect(service.getClusterNodes()).resolves.toEqual([
      { ...clusterNodes[0], availabilityZone: 'us-east-1a', shardId: 'shard-1' },
    ]);
  });

  it('returns the nodes unchanged when CLUSTER SHARDS fails', async () => {
    const { service } = makeClusterService(jest.fn().mockRejectedValue(new Error('ERR unknown subcommand')));

    await expect(service.getClusterNodes()).resolves.toEqual(clusterNodes);
  });

  it('fills the zone from the connection map when the server reports none', async () => {
    const { service, registry } = makeClusterService(jest.fn().mockResolvedValue([]), { '10.0.0.1:6379': 'rack-a' });

    await expect(service.getClusterNodes('conn-1')).resolves.toEqual([{ ...clusterNodes[0], availabilityZone: 'rack-a' }]);
    expect(registry.getNodeAvailabilityZones).toHaveBeenCalledWith('conn-1');
  });

  it('reads the zone map of the default connection the nodes came from when the default changes mid-read', async () => {
    let defaultId = 'conn-a';
    const client = {
      getClusterNodes: jest.fn(async () => {
        defaultId = 'conn-b';
        return clusterNodes;
      }),
      getClusterShards: jest.fn().mockResolvedValue([]),
    };
    const registry = {
      get: jest.fn().mockReturnValue(client),
      getDefaultId: jest.fn(() => defaultId),
      getNodeAvailabilityZones: jest.fn().mockReturnValue(undefined),
    };
    const service = new MetricsService(registry as unknown as ConnectionRegistry, {} as StoragePort);

    await service.getClusterNodes();

    expect(registry.get).toHaveBeenCalledWith('conn-a');
    expect(registry.getNodeAvailabilityZones).toHaveBeenCalledWith('conn-a');
  });

  it('fills the zone from the connection map on a reply without zones, as before 9.1', async () => {
    const { service } = makeClusterService(
      jest.fn().mockResolvedValue([{ slots: [[0, 16383]], nodes: [{ id: 'primary-1', role: 'master' }] }]),
      { '10.0.0.1:6379': 'rack-a' },
    );

    await expect(service.getClusterNodes()).resolves.toEqual([{ ...clusterNodes[0], availabilityZone: 'rack-a' }]);
  });

  it('fills the zone from the connection map when CLUSTER SHARDS fails', async () => {
    const { service } = makeClusterService(jest.fn().mockRejectedValue(new Error('ERR unknown subcommand')), {
      '10.0.0.1:6379': 'rack-a',
    });

    await expect(service.getClusterNodes()).resolves.toEqual([{ ...clusterNodes[0], availabilityZone: 'rack-a' }]);
  });

  it('keeps the zone the server reports over the connection map', async () => {
    const { service } = makeClusterService(
      jest.fn().mockResolvedValue([
        { slots: [[0, 16383]], nodes: [{ id: 'primary-1', role: 'master', availabilityZone: 'us-east-1a' }] },
      ]),
      { '10.0.0.1:6379': 'rack-a' },
    );

    await expect(service.getClusterNodes()).resolves.toEqual([{ ...clusterNodes[0], availabilityZone: 'us-east-1a' }]);
  });
});
