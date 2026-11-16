import type { ClusterNode } from '@app/common/types/metrics.types';
import { ClusterNodeViews, nodeOfEvent } from '../event-node';
import { AnomalySeverity, AnomalyType, MetricType, type AnomalyEvent } from '../types';

function node(overrides: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'address'>): ClusterNode {
  return {
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [],
    ...overrides,
  };
}

function event(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
  return {
    id: 'event-1',
    timestamp: 1_700_000_000_000,
    metricType: MetricType.MEMORY_USED,
    anomalyType: AnomalyType.SPIKE,
    severity: AnomalySeverity.WARNING,
    value: 1,
    baseline: 0,
    stdDev: 0,
    zScore: 0,
    threshold: 0,
    message: 'm',
    resolved: false,
    connectionId: 'conn-a',
    ...overrides,
  };
}

const PRIMARY_A = node({ id: 'primary-a', address: '10.0.0.1:6379@16379', shardId: 'shard-a' });
const REPLICA_A = node({
  id: 'replica-a',
  address: '10.0.0.2:6379@16379',
  flags: ['slave'],
  master: 'primary-a',
  shardId: 'shard-a',
  availabilityZone: 'eu-west-1b',
});
const PRIMARY_B = node({ id: 'primary-b', address: '10.0.0.3:6379@16379', shardId: 'shard-b' });

function seenFrom(self: ClusterNode): ClusterNode[] {
  return [PRIMARY_A, REPLICA_A, PRIMARY_B].map((n) =>
    n.id === self.id ? { ...n, flags: ['myself', ...n.flags] } : n,
  );
}

describe('nodeOfEvent', () => {
  const views = new ClusterNodeViews();
  views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
  const directory = views.view('cluster-1')?.directory;
  const ownNodeId = views.ownNodeId('conn-a');
  const resolve = (overrides: Partial<AnomalyEvent>) => nodeOfEvent(event(overrides), directory, ownNodeId);

  it('names the connection own node for an event about the node that was read', () => {
    expect(resolve({})).toEqual({
      nodeId: 'primary-a',
      address: '10.0.0.1:6379',
      role: 'primary',
      shardId: 'shard-a',
    });
  });

  it('gives the node of a role change the role it changed to', () => {
    const demoted = resolve({ metricType: MetricType.REPLICATION_ROLE, value: 0, baseline: 1 });
    const promoted = resolve({ metricType: MetricType.REPLICATION_ROLE, value: 1, baseline: 0 });

    expect(demoted).toMatchObject({ nodeId: 'primary-a', role: 'replica' });
    expect(promoted).toMatchObject({ nodeId: 'primary-a', role: 'primary' });
  });

  it('names the node a detector points at over the own node', () => {
    expect(resolve({ metricType: MetricType.GHOST_MEMBERSHIP, nodeSubject: { nodeId: 'primary-b' } })?.nodeId).toBe(
      'primary-b',
    );
  });

  it('names the replica for an event about a replica', () => {
    expect(
      resolve({
        metricType: MetricType.REPLICATION_DIVERGENCE,
        replicaAddr: '10.0.0.2:6379',
        nodeAddr: '10.0.0.3:6379',
      }),
    ).toEqual({
      nodeId: 'replica-a',
      address: '10.0.0.2:6379',
      role: 'replica',
      shardId: 'shard-a',
      availabilityZone: 'eu-west-1b',
    });
  });

  it('names no node when the replica of a replica event is not in the view', () => {
    expect(resolve({ metricType: MetricType.RESYNC_ESCALATION, replicaAddr: '10.9.9.9:6379' })).toBeUndefined();
  });

  it('ignores the replica address on an event that is not about the replica', () => {
    expect(resolve({ metricType: MetricType.REPL_BUFFER_PRESSURE, replicaAddr: '10.0.0.2:6379' })?.nodeId).toBe(
      'primary-a',
    );
  });

  it('names the other primary an event was raised about', () => {
    expect(resolve({ metricType: MetricType.HOT_SHARD, nodeAddr: '10.0.0.3:6379' })?.nodeId).toBe('primary-b');
  });

  it('names no node when the other primary is not in the view', () => {
    expect(resolve({ metricType: MetricType.HOT_SHARD, nodeAddr: '10.9.9.9:6379' })).toBeUndefined();
  });

  it('keeps the id and address a detector gave for a node that left the view', () => {
    expect(
      resolve({ metricType: MetricType.GHOST_MEMBERSHIP, nodeSubject: { nodeId: 'gone', address: '10.0.0.9:6379@16379' } }),
    ).toEqual({ nodeId: 'gone', address: '10.0.0.9:6379', role: 'unknown' });
  });

  it('names no node for a detector subject that is unknown and has no address', () => {
    expect(resolve({ metricType: MetricType.GHOST_MEMBERSHIP, nodeSubject: { nodeId: 'gone' } })).toBeUndefined();
  });

  it.each([
    MetricType.CLUSTER_STATE,
    MetricType.RAFT_HEALTH,
    MetricType.SENTINEL_ENDPOINT_DRIFT,
    MetricType.SENTINEL_LOOP_STALL,
  ])('names no node for the cluster-wide %s event', (metricType) => {
    expect(resolve({ metricType, nodeAddr: '10.0.0.3:6379' })).toBeUndefined();
  });

  it('names the one node that disagrees on a topology divergence', () => {
    expect(resolve({ metricType: MetricType.TOPOLOGY_DIVERGENCE, nodeAddr: '10.0.0.3:6379' })?.nodeId).toBe(
      'primary-b',
    );
  });

  it('names no node on a topology divergence with several nodes on each side', () => {
    expect(resolve({ metricType: MetricType.TOPOLOGY_DIVERGENCE })).toBeUndefined();
  });

  it('keeps a node the event already carries', () => {
    const node = { nodeId: 'x', address: '1.1.1.1:1', role: 'unknown' as const };
    expect(resolve({ node })).toBe(node);
  });

  it('gives the node an unknown role when the view is too old to say', () => {
    expect(nodeOfEvent(event(), directory, ownNodeId, false)).toEqual({
      nodeId: 'primary-a',
      address: '10.0.0.1:6379',
      role: 'unknown',
      shardId: 'shard-a',
    });
  });

  it('keeps the role of a node the event already carries when the view is old', () => {
    const node = { nodeId: 'x', address: '1.1.1.1:1', role: 'primary' as const };
    expect(nodeOfEvent(event({ node }), directory, ownNodeId, false)).toBe(node);
  });

  it('names no node without a cluster view', () => {
    expect(nodeOfEvent(event(), undefined, undefined)).toBeUndefined();
  });
});

describe('ClusterNodeViews', () => {
  const withNewNode = [...seenFrom(PRIMARY_B), node({ id: 'new', address: '10.0.0.4:6379@16379' })];

  it('keeps one view for the connections of a cluster', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-b', 'cluster-1', withNewNode, 2_000);

    expect(views.view('cluster-1')).toMatchObject({ readAt: 2_000 });
    expect(views.view('cluster-1')?.directory.byId.has('new')).toBe(true);
  });

  it('keeps the views of two clusters apart', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-b', 'cluster-2', withNewNode, 2_000);

    expect(views.view('cluster-1')?.directory.byId.has('new')).toBe(false);
  });

  it('keeps the newer read when an older one arrives late', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-b', 'cluster-1', withNewNode, 2_000);
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);

    expect(views.view('cluster-1')).toMatchObject({ readAt: 2_000 });
    expect(views.view('cluster-1')?.directory.byId.has('new')).toBe(true);
  });

  it('builds the directory only when it is asked for, once per read', () => {
    const views = new ClusterNodeViews();
    const describe = jest.fn(() => seenFrom(PRIMARY_B));
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000, describe);
    views.remember('conn-b', 'cluster-1', seenFrom(PRIMARY_B), 2_000, describe);

    expect(describe).not.toHaveBeenCalled();

    const first = views.view('cluster-1')?.directory;
    const second = views.view('cluster-1')?.directory;

    expect(describe).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('builds the directory from the described nodes', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000, () =>
      seenFrom(PRIMARY_A).map((n) => ({ ...n, availabilityZone: 'zone-x' })),
    );

    expect(views.view('cluster-1')?.directory.byId.get('primary-a')?.availabilityZone).toBe('zone-x');
  });

  it('keeps each connection own node apart from the shared view', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-b', 'cluster-1', seenFrom(PRIMARY_B), 2_000);

    const node = nodeOfEvent(event(), views.view('cluster-1')?.directory, views.ownNodeId('conn-a'));

    expect(node?.nodeId).toBe('primary-a');
  });

  it('keeps the own node of a connection whose later read marks none', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-a', 'cluster-1', [PRIMARY_A, REPLICA_A], 2_000);

    expect(views.ownNodeId('conn-a')).toBe('primary-a');
  });

  it('moves a connection to the view of its cluster once the cluster is known', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'conn-a', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 2_000);

    expect(views.view('conn-a')).toBeUndefined();
    expect(views.view('cluster-1')).toMatchObject({ readAt: 2_000 });
  });

  it('keeps the view of a cluster while another connection still reads it', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-b', 'cluster-1', seenFrom(PRIMARY_B), 2_000);
    views.forget('conn-b');

    expect(views.view('cluster-1')).toBeDefined();
    expect(views.ownNodeId('conn-b')).toBeUndefined();
  });

  it('forgets the view with the last connection of the cluster', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.forget('conn-a');

    expect(views.view('cluster-1')).toBeUndefined();
    expect(views.ownNodeId('conn-a')).toBeUndefined();
    expect(views.connectionsOfNode('primary-a')).toEqual([]);
  });

  it('answers with the connections that read a node as their own', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-a2', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-b', 'cluster-1', seenFrom(PRIMARY_B), 1_000);

    expect(views.connectionsOfNode('primary-a')).toEqual(['conn-a', 'conn-a2']);
    expect(views.connectionsOfNode('replica-a')).toEqual([]);
  });
});
