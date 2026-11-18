import type { ClusterNode } from '@app/common/types/metrics.types';
import { ClusterNodeViews, nodeOfEvent, nodeRoleOfInfo, ownNodeIdOf } from '../event-node';
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
  const ownNodeId = ownNodeIdOf(seenFrom(PRIMARY_A));
  const resolve = (overrides: Partial<AnomalyEvent>) => nodeOfEvent(event(overrides), directory, ownNodeId);

  it('names the connection own node for an event about the node that was read', () => {
    expect(resolve({})).toEqual({
      nodeId: 'primary-a',
      address: '10.0.0.1:6379',
      role: 'primary',
      shardId: 'shard-a',
    });
  });

  it.each([MetricType.CONNECTIONS, MetricType.MEMORY_USED])(
    'gives the own node the role the connection read for it on a %s event',
    (metricType) => {
      const demoted = nodeOfEvent(event({ metricType }), directory, ownNodeId, true, 'replica');
      const promoted = nodeOfEvent(event({ metricType }), directory, ownNodeId, true, 'primary');

      expect(demoted).toMatchObject({ nodeId: 'primary-a', role: 'replica' });
      expect(promoted).toMatchObject({ nodeId: 'primary-a', role: 'primary' });
    },
  );

  it.each([
    ['a promotion', 1, 'primary'],
    ['a demotion', 0, 'replica'],
  ])('gives the own node of %s the role it changed to, with no own read and a view too old to say', (_what, value, role) => {
    const change = event({ metricType: MetricType.REPLICATION_ROLE, value });

    expect(nodeOfEvent(change, directory, ownNodeId, false)).toMatchObject({ nodeId: 'primary-a', role });
  });

  it('gives the own node of a role change the role it changed to over an own read that says otherwise', () => {
    const promotion = event({ metricType: MetricType.REPLICATION_ROLE, value: 1 });

    expect(nodeOfEvent(promotion, directory, ownNodeId, true, 'replica')).toMatchObject({
      nodeId: 'primary-a',
      role: 'primary',
    });
  });

  it('keeps the role of the view for a node that is not the own node', () => {
    const about = event({ metricType: MetricType.CLUSTER_TOPOLOGY, nodeSubject: { nodeId: 'replica-a' } });

    expect(nodeOfEvent(about, directory, ownNodeId, true, 'primary')).toMatchObject({
      nodeId: 'replica-a',
      role: 'replica',
    });
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

  it('keeps the role the connection read for its own node when the view is too old to say', () => {
    expect(nodeOfEvent(event(), directory, ownNodeId, false, 'replica')?.role).toBe('replica');
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

describe('nodeRoleOfInfo', () => {
  it.each([
    ['master', 'primary'],
    ['slave', 'replica'],
    ['replica', 'replica'],
    ['active-replica', undefined],
    ['sentinel', undefined],
    [undefined, undefined],
  ])('reads INFO role %s as %s', (role, expected) => {
    expect(nodeRoleOfInfo(role)).toBe(expected);
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

  describe('when a read did not ask for the shards', () => {
    const withoutShards = (nodes: ClusterNode[]): ClusterNode[] =>
      nodes.map(({ shardId, availabilityZone, ...rest }) => rest);
    const movedToShardB = (nodes: ClusterNode[]): ClusterNode[] =>
      nodes.map((n) => (n.id === 'replica-a' ? { ...n, master: 'primary-b', shardId: 'shard-b' } : n));
    const shardOf = (views: ClusterNodeViews, id: string) =>
      views.view('cluster-1')?.directory.byId.get(id)?.shardId;

    it('takes the shards of a shard read that arrives later with an older time', () => {
      const views = new ClusterNodeViews();
      views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
      views.remember('conn-b', 'cluster-1', withoutShards(seenFrom(PRIMARY_B)), 3_000, undefined, false);
      views.remember('conn-a', 'cluster-1', movedToShardB(seenFrom(PRIMARY_A)), 2_000);

      expect(views.view('cluster-1')).toMatchObject({ readAt: 3_000 });
      expect(shardOf(views, 'replica-a')).toBe('shard-b');
    });

    it('keeps the shards it has when the shard read that arrives is older than theirs', () => {
      const views = new ClusterNodeViews();
      views.remember('conn-a', 'cluster-1', movedToShardB(seenFrom(PRIMARY_A)), 2_000);
      views.remember('conn-b', 'cluster-1', withoutShards(seenFrom(PRIMARY_B)), 3_000, undefined, false);
      views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);

      expect(shardOf(views, 'replica-a')).toBe('shard-b');
    });

    it('keeps the shards of the last shard read over several reads without them', () => {
      const views = new ClusterNodeViews();
      views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
      views.remember('conn-b', 'cluster-1', withoutShards(seenFrom(PRIMARY_B)), 2_000, undefined, false);
      views.remember('conn-a', 'cluster-1', withoutShards(seenFrom(PRIMARY_A)), 3_000, undefined, false);

      expect(views.view('cluster-1')).toMatchObject({ readAt: 3_000 });
      expect(shardOf(views, 'replica-a')).toBe('shard-a');
    });

    it('has no shard for a node the last shard read did not list', () => {
      const views = new ClusterNodeViews();
      views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
      views.remember('conn-b', 'cluster-1', withoutShards(withNewNode), 2_000, undefined, false);

      expect(views.view('cluster-1')?.directory.byId.has('new')).toBe(true);
      expect(shardOf(views, 'new')).toBeUndefined();
    });
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

  it('reads the node a connection answers from off the line the node reports as itself', () => {
    expect(ownNodeIdOf(seenFrom(PRIMARY_B))).toBe(PRIMARY_B.id);
    expect(ownNodeIdOf([PRIMARY_A, PRIMARY_B])).toBeUndefined();
  });

  it('moves a connection to the view of its cluster once the cluster is known', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'conn-a', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 2_000);

    expect(views.view('conn-a')).toBeUndefined();
    expect(views.view('cluster-1')).toMatchObject({ readAt: 2_000 });
  });

  it('says under which key a connection last stored its view', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);

    expect(views.keyOf('conn-a')).toBe('cluster-1');
    expect(views.keyOf('conn-b')).toBeUndefined();
  });

  it('keeps the view of a cluster while another connection still reads it', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.remember('conn-b', 'cluster-1', seenFrom(PRIMARY_B), 2_000);
    views.forget('conn-b');

    expect(views.view('cluster-1')).toBeDefined();
  });

  it('forgets the view with the last connection of the cluster', () => {
    const views = new ClusterNodeViews();
    views.remember('conn-a', 'cluster-1', seenFrom(PRIMARY_A), 1_000);
    views.forget('conn-a');

    expect(views.view('cluster-1')).toBeUndefined();
  });

  it('keeps the role each connection read for its own node, with when it was read', () => {
    const views = new ClusterNodeViews();
    views.rememberOwnRole('conn-a', 'primary', 1_000);
    views.rememberOwnRole('conn-b', 'replica', 2_000);

    expect(views.ownRole('conn-a')).toEqual({ role: 'primary', readAt: 1_000 });
    expect(views.ownRole('conn-b')).toEqual({ role: 'replica', readAt: 2_000 });
  });

  it('drops the own role of a connection whose read names none', () => {
    const views = new ClusterNodeViews();
    views.rememberOwnRole('conn-a', 'primary', 1_000);
    views.rememberOwnRole('conn-a', undefined, 2_000);

    expect(views.ownRole('conn-a')).toBeUndefined();
  });

  it('forgets the own role with the connection', () => {
    const views = new ClusterNodeViews();
    views.rememberOwnRole('conn-a', 'primary', 1_000);
    views.forget('conn-a');

    expect(views.ownRole('conn-a')).toBeUndefined();
  });

});
