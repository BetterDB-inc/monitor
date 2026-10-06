import { ClusterTopologySource } from '../cluster-topology.source';

const seed = { id: 'seed', name: 'prod', host: 'seed.local', port: 7001, isDefault: true, createdAt: 1 };

describe('ClusterTopologySource', () => {
  it('handles cluster-enabled seeds only', () => {
    const source = new ClusterTopologySource({} as never);
    expect(source.handles({ clusterEnabled: true } as never)).toBe(true);
    expect(source.handles({ clusterEnabled: false } as never)).toBe(false);
  });

  it('maps CLUSTER NODES to desired cluster nodes, dropping the seed', async () => {
    const discovery = { discoverNodesIsolated: jest.fn().mockResolvedValue([
      { id: 'self', address: 'seed.local:7001@17001', flags: ['myself', 'master'], role: 'master', slots: [], configEpoch: 0, healthy: true },
      { id: 'n2', address: '10.0.0.2:7002@17002', flags: ['master'], role: 'master', slots: [], configEpoch: 0, healthy: true },
    ]) };
    const source = new ClusterTopologySource(discovery as never);
    await expect(source.discover(seed as never, 10_000)).resolves.toEqual({
      nodes: [{ host: '10.0.0.2', port: 7002, nodeId: 'n2', source: 'cluster' }],
      unknownGroups: [],
    });
    expect(discovery.discoverNodesIsolated).toHaveBeenCalledWith('seed', 10_000);
  });
});
