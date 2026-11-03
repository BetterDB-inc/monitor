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
    source.resolveHost = jest.fn().mockResolvedValue(['10.0.0.1']);
    await expect(source.discover(seed as never, 10_000)).resolves.toEqual({
      nodes: [{ host: '10.0.0.2', port: 7002, nodeId: 'n2', source: 'cluster' }],
      unknownGroups: [],
    });
    expect(discovery.discoverNodesIsolated).toHaveBeenCalledWith('seed', 10_000);
  });

  it('keeps the node that answered when the seed host resolves to several nodes', async () => {
    // Kubernetes headless Service: every discovery lands on a random pod, so
    // `myself` is a real node and dropping it retired a different node each sync.
    const discovery = { discoverNodesIsolated: jest.fn().mockResolvedValue([
      { id: 'n1', address: '10.0.0.1:6379@16379', flags: ['myself', 'master'], role: 'master', slots: [], configEpoch: 0, healthy: true },
      { id: 'n2', address: '10.0.0.2:6379@16379', flags: ['slave'], role: 'replica', slots: [], configEpoch: 0, healthy: true },
    ]) };
    const source = new ClusterTopologySource(discovery as never);
    source.resolveHost = jest.fn().mockResolvedValue(['10.0.0.1', '10.0.0.2']);
    const result = await source.discover({ ...seed, host: 'valkey.ns.svc.cluster.local', port: 6379 } as never, 10_000);
    expect(result?.nodes.map((n) => n.nodeId)).toEqual(['n1', 'n2']);
    expect(source.resolveHost).toHaveBeenCalledWith('valkey.ns.svc.cluster.local');
  });

  it('still drops myself when the seed host resolves to a single address or not at all', async () => {
    const nodes = [
      { id: 'n1', address: '10.0.0.1:6379@16379', flags: ['myself', 'master'], role: 'master', slots: [], configEpoch: 0, healthy: true },
      { id: 'n2', address: '10.0.0.2:6379@16379', flags: ['slave'], role: 'replica', slots: [], configEpoch: 0, healthy: true },
    ];
    for (const addresses of [['10.0.0.1'], []]) {
      const source = new ClusterTopologySource({ discoverNodesIsolated: jest.fn().mockResolvedValue(nodes) } as never);
      source.resolveHost = jest.fn().mockResolvedValue(addresses);
      const result = await source.discover({ ...seed, host: 'node-1.local', port: 6379 } as never, 10_000);
      expect(result?.nodes.map((n) => n.nodeId)).toEqual(['n2']);
    }
  });
});
