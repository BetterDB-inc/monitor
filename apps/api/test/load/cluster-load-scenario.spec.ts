import { downOutsideHung, hangLimit, pickHungNodes } from '../../scripts/cluster-load/hung-nodes';
import { pollerResult } from '../../scripts/cluster-load/poller-result';

const HOST = '127.0.0.1';

const clusterOf = (shards: number, replicasPerShard: number) =>
  Array.from({ length: shards * (1 + replicasPerShard) }, (_, index) => ({
    index,
    host: HOST,
    port: 7000 + index,
    shard: Math.floor(index / (1 + replicasPerShard)),
  }));

const connectionTo = (node: { host: string; port: number }, isConnected: boolean) => ({
  host: node.host,
  port: node.port,
  isConnected,
});

describe('cluster load test, hung nodes', () => {
  it('hangs the last nodes of the cluster', () => {
    expect(pickHungNodes(clusterOf(3, 1), 2, null)).toEqual([5, 4]);
  });

  it('never hangs the seed node', () => {
    expect(pickHungNodes(clusterOf(2, 1), 3, null)).toEqual([3, 2, 1]);
    expect(() => pickHungNodes(clusterOf(2, 1), 4, null)).toThrow('4 nodes to hang');
  });

  it('leaves the shard of the failover alone', () => {
    expect(pickHungNodes(clusterOf(2, 1), 1, 1)).toEqual([1]);
    expect(pickHungNodes(clusterOf(3, 1), 2, 1)).toEqual([5, 4]);
    expect(pickHungNodes(clusterOf(3, 1), 3, 1)).toEqual([5, 4, 1]);
  });

  it('refuses more hung nodes than the failover leaves', () => {
    expect(() => pickHungNodes(clusterOf(2, 1), 2, 1)).toThrow('2 nodes to hang');
  });

  it('counts how many nodes can hang', () => {
    expect(hangLimit(4, 2, false)).toBe(3);
    expect(hangLimit(4, 2, true)).toBe(1);
    expect(hangLimit(100, 2, true)).toBe(97);
  });
});

describe('cluster load test, connections down at the end', () => {
  const nodes = clusterOf(3, 1);

  it('counts a dropped seed connection although a node was made to hang', () => {
    const hung = [nodes[5]];
    expect(downOutsideHung([connectionTo(nodes[0], false)], hung)).toBe(1);
  });

  it('counts nothing while the seed connection is up', () => {
    expect(downOutsideHung([connectionTo(nodes[0], true)], [nodes[5]])).toBe(0);
  });

  it('counts a healthy connection that is down with every node registered', () => {
    const hung = [nodes[5], nodes[4]];
    const connections = nodes.map((node) => connectionTo(node, node.index !== 2));
    expect(downOutsideHung(connections, hung)).toBe(1);
  });

  it('leaves out the connections to the hung nodes with every node registered', () => {
    const hung = [nodes[5], nodes[4]];
    const connections = nodes.map((node) => connectionTo(node, node.index < 4));
    expect(downOutsideHung(connections, hung)).toBe(0);
  });
});

describe('cluster load test, pass times', () => {
  const pass = (durations: number[]) => pollerResult(durations, 1000, 0, 120);

  it('reads p50 of two passes between them', () => {
    expect(pass([200, 100]).p50Ms).toBe(150);
  });

  it('reads p95 of twenty passes below the slowest', () => {
    const durations = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
    const result = pass(durations);
    expect(result.p95Ms).toBe(190.5);
    expect(result.maxMs).toBe(200);
  });

  it('reports the passes done, the passes an idle poller would do and the commands', () => {
    expect(pollerResult([100, 100, 100, 100], 1000, 480, 120)).toEqual({
      intervalMs: 1000,
      ticks: 4,
      expectedTicks: 120,
      p50Ms: 100,
      p95Ms: 100,
      maxMs: 100,
      commandsPerTick: 120,
      commandsPerSecond: 4,
    });
  });

  it('reports zeros for a poller without a pass', () => {
    expect(pollerResult([], 0, 0, 120)).toEqual({
      intervalMs: 0,
      ticks: 0,
      expectedTicks: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
      commandsPerTick: 0,
      commandsPerSecond: 0,
    });
  });
});
