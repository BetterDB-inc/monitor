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
    const service = { ...seed, host: 'valkey.ns.svc.cluster.local', port: 6379 };
    // The first alias verdict is not trusted yet, so membership is left alone.
    await expect(source.discover(service as never, 10_000)).resolves.toBeNull();
    const result = await source.discover(service as never, 10_000);
    expect(result?.nodes.map((n) => n.nodeId)).toEqual(['n1', 'n2']);
    expect(source.resolveHost).toHaveBeenCalledWith('valkey.ns.svc.cluster.local');
  });

  const nodes = [
    { id: 'n1', address: '10.0.0.1:6379@16379', flags: ['myself', 'master'], role: 'master', slots: [], configEpoch: 0, healthy: true },
    { id: 'n2', address: '10.0.0.2:6379@16379', flags: ['slave'], role: 'replica', slots: [], configEpoch: 0, healthy: true },
  ];
  // Two syncs, so an alias verdict is confirmed; the second sync's result.
  const discoverWith = async (addresses: string[]) => {
    const source = new ClusterTopologySource({ discoverNodesIsolated: jest.fn().mockResolvedValue(nodes) } as never);
    source.resolveHost = jest.fn().mockResolvedValue(addresses);
    await source.discover({ ...seed, host: 'node-1.example', port: 6379 } as never, 10_000);
    return source.discover({ ...seed, host: 'node-1.example', port: 6379 } as never, 10_000);
  };

  it('drops myself when the seed resolves to that one node, also over IPv4 and IPv6', async () => {
    expect((await discoverWith(['10.0.0.1']))?.nodes.map((n) => n.nodeId)).toEqual(['n2']);
    expect((await discoverWith(['10.0.0.1', 'fd00::1']))?.nodes.map((n) => n.nodeId)).toEqual(['n2']);
  });

  const landedOnN2 = [
    { ...nodes[0], flags: ['slave'] },
    { ...nodes[1], flags: ['myself', 'master'] },
  ];
  const vip = { ...seed, host: 'valkey.ns.svc.cluster.local', port: 6379 };
  const unmatchedSource = (...answers: (typeof nodes)[]) => {
    const discoverNodesIsolated = jest.fn();
    for (const answer of answers) discoverNodesIsolated.mockResolvedValueOnce(answer);
    const source = new ClusterTopologySource({ discoverNodesIsolated } as never);
    source.resolveHost = jest.fn().mockResolvedValue(['10.96.0.10']);
    return source;
  };

  it('keeps every answering node once a seed that matches no node lands on a node again (a Service VIP)', async () => {
    const source = unmatchedSource(nodes, landedOnN2, nodes, landedOnN2);

    expect(ids(await source.discover(vip as never, 10_000))).toEqual(['n2']);
    // Another node answered: a VIP or a moved endpoint, so membership waits.
    await expect(source.discover(vip as never, 10_000)).resolves.toBeNull();
    expect(ids(await source.discover(vip as never, 10_000))).toEqual(['n1', 'n2']);
    expect(ids(await source.discover(vip as never, 10_000))).toEqual(['n1', 'n2']);
  });

  it('follows a seed that matches no node to the node it moved to (a failover behind NAT)', async () => {
    const source = unmatchedSource(nodes, nodes, landedOnN2, landedOnN2, landedOnN2, landedOnN2);

    expect(ids(await source.discover(vip as never, 10_000))).toEqual(['n2']);
    expect(ids(await source.discover(vip as never, 10_000))).toEqual(['n2']);
    await expect(source.discover(vip as never, 10_000)).resolves.toBeNull();
    await expect(source.discover(vip as never, 10_000)).resolves.toBeNull();
    // n2 has answered three syncs in a row: the seed is n2 now, n1 a child.
    expect(ids(await source.discover(vip as never, 10_000))).toEqual(['n1']);
    expect(ids(await source.discover(vip as never, 10_000))).toEqual(['n1']);
  });

  it('drops myself for a seed that matches no node while the same node keeps answering (NAT, a port mapping)', async () => {
    expect((await discoverWith(['203.0.113.5']))?.nodes.map((n) => n.nodeId)).toEqual(['n2']);
  });

  it('keeps myself after a restart for a seed that matches no node when myself is already a member', async () => {
    const source = new ClusterTopologySource({ discoverNodesIsolated: jest.fn().mockResolvedValue(nodes) } as never);
    source.resolveHost = jest.fn().mockResolvedValue(['10.96.0.10']);
    const vip = { ...seed, host: 'valkey.ns.svc.cluster.local', port: 6379 };
    const result = await source.discover(vip as never, 10_000, new Set(['n1', 'n2']));
    expect(result?.nodes.map((n) => n.nodeId)).toEqual(['n1', 'n2']);
  });

  it('leaves membership unchanged when the seed host does not resolve', async () => {
    await expect(discoverWith([])).resolves.toBeNull();
  });

  const single = { ...seed, host: 'node-1.example', port: 6379 };
  const ids = (result: Awaited<ReturnType<ClusterTopologySource['discover']>>) => result?.nodes.map((n) => n.nodeId);

  it('does not let one stale alias verdict register a single-node seed as its own child', async () => {
    const source = new ClusterTopologySource({ discoverNodesIsolated: jest.fn().mockResolvedValue(nodes) } as never);
    // The pod IP changed and the cached answer does not match myself for one sync.
    source.resolveHost = jest.fn()
      .mockResolvedValueOnce(['10.0.0.1'])
      .mockResolvedValueOnce(['10.0.0.9'])
      .mockResolvedValueOnce(['10.0.0.1']);

    expect(ids(await source.discover(single as never, 10_000))).toEqual(['n2']);
    expect(ids(await source.discover(single as never, 10_000))).toEqual(['n2']);
    expect(ids(await source.discover(single as never, 10_000))).toEqual(['n2']);
  });

  it('changes a seed between alias and one node only after two verdicts in a row', async () => {
    const source = new ClusterTopologySource({ discoverNodesIsolated: jest.fn().mockResolvedValue(nodes) } as never);
    source.resolveHost = jest.fn()
      .mockResolvedValueOnce(['10.0.0.1', '10.0.0.2'])
      .mockResolvedValueOnce(['10.0.0.1', '10.0.0.2'])
      .mockResolvedValueOnce(['10.0.0.1'])
      .mockResolvedValueOnce(['10.0.0.1']);

    await expect(source.discover(single as never, 10_000)).resolves.toBeNull();
    expect(ids(await source.discover(single as never, 10_000))).toEqual(['n1', 'n2']);
    // A rollout leaves one pod behind the name for a sync: myself stays.
    expect(ids(await source.discover(single as never, 10_000))).toEqual(['n1', 'n2']);
    expect(ids(await source.discover(single as never, 10_000))).toEqual(['n2']);
  });

  it('starts over for a seed it was told to forget', async () => {
    const source = new ClusterTopologySource({ discoverNodesIsolated: jest.fn().mockResolvedValue(nodes) } as never);
    source.resolveHost = jest.fn().mockResolvedValue(['10.0.0.1', '10.0.0.2']);

    await source.discover(single as never, 10_000);
    source.forget('seed');

    await expect(source.discover(single as never, 10_000)).resolves.toBeNull();
  });
});
