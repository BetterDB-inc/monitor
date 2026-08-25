import { ClusterNode } from '../../common/types/metrics.types';
import { diffClusterTopology, roleFromFlags, snapshotTopology } from '../topology-diff';

function node(overrides: Partial<ClusterNode> & { id: string }): ClusterNode {
  return {
    address: `${overrides.id}:6379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 5460]],
    ...overrides,
  };
}

function replica(id: string, masterId: string, overrides: Partial<ClusterNode> = {}): ClusterNode {
  return node({ id, flags: ['slave'], master: masterId, slots: [], ...overrides });
}

const MASTER_A = node({ id: 'a' });
const REPLICA_B = replica('b', 'a');

describe('diffClusterTopology', () => {
  it('reports no change for an identical topology', () => {
    const before = snapshotTopology([MASTER_A, REPLICA_B]);
    const after = snapshotTopology([MASTER_A, REPLICA_B]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(result.changedNodes).toEqual([]);
  });

  it('detects a master demoted to replica', () => {
    const before = snapshotTopology([MASTER_A, REPLICA_B]);
    const after = snapshotTopology([replica('a', 'b'), node({ id: 'b' })]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(true);
    expect(result.reasons).toContain('role_change');
    expect(result.changedNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'a', from: 'master', to: 'replica' }),
        expect.objectContaining({ nodeId: 'b', from: 'replica', to: 'master' }),
      ]),
    );
  });

  it('detects a replica promoted to master', () => {
    const before = snapshotTopology([REPLICA_B]);
    const after = snapshotTopology([node({ id: 'b' })]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(true);
    expect(result.reasons).toContain('role_change');
  });

  it("detects a shard's primary changing under a replica that keeps its role", () => {
    const before = snapshotTopology([REPLICA_B]);
    const after = snapshotTopology([replica('b', 'c')]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(true);
    expect(result.reasons).toContain('primary_change');
  });

  it('does not call a lone configEpoch bump a failover', () => {
    // Epochs also advance on CLUSTER BUMPEPOCH and on the slot-ownership claim
    // during resharding, neither of which is a failover. Every real failover
    // promotes a replica, so role_change already covers them; firing on the
    // epoch alone would page on routine rebalancing.
    const before = snapshotTopology([MASTER_A]);
    const after = snapshotTopology([node({ id: 'a', configEpoch: 7 })]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("reports another node's epoch bump once a real failover is in the diff", () => {
    // A promoted node bumps its own epoch as part of promotion, so that is not
    // separate information. A bump on an uninvolved node during the same window
    // is, and it rides along once something genuinely failed over.
    const before = snapshotTopology([MASTER_A, REPLICA_B, node({ id: 'c' })]);
    const after = snapshotTopology([
      replica('a', 'b'),
      node({ id: 'b' }),
      node({ id: 'c', configEpoch: 9 }),
    ]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(true);
    expect(result.reasons).toEqual(expect.arrayContaining(['role_change', 'epoch_bump']));
  });

  it("does not report a promoted node's own epoch bump separately", () => {
    const before = snapshotTopology([REPLICA_B]);
    const after = snapshotTopology([node({ id: 'b', configEpoch: 9 })]);

    const result = diffClusterTopology(before, after);

    expect(result.reasons).toEqual(['role_change']);
  });

  it('ignores a configEpoch that decreases', () => {
    // Epochs only ever advance. A lower value is a stale or reordered read,
    // not a failover, and treating it as one would fire on read skew.
    const before = snapshotTopology([node({ id: 'a', configEpoch: 7 })]);
    const after = snapshotTopology([node({ id: 'a', configEpoch: 1 })]);

    expect(diffClusterTopology(before, after).changed).toBe(false);
  });

  it('does not report a failover when a node joins', () => {
    const before = snapshotTopology([MASTER_A]);
    const after = snapshotTopology([MASTER_A, REPLICA_B]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(false);
  });

  it('does not report a failover when a node leaves', () => {
    const before = snapshotTopology([MASTER_A, REPLICA_B]);
    const after = snapshotTopology([MASTER_A]);

    const result = diffClusterTopology(before, after);

    expect(result.changed).toBe(false);
  });

  it('reports each distinct reason once even across several nodes', () => {
    const before = snapshotTopology([MASTER_A, REPLICA_B]);
    const after = snapshotTopology([replica('a', 'b'), node({ id: 'b', configEpoch: 9 })]);

    const result = diffClusterTopology(before, after);

    expect(result.reasons.filter((r) => r === 'role_change')).toHaveLength(1);
  });

  it('treats a null previous snapshot as nothing to compare', () => {
    // First poll after process start: every node looks new, and reporting a
    // failover for each one would make every restart look like an incident.
    const result = diffClusterTopology(null, snapshotTopology([MASTER_A, REPLICA_B]));

    expect(result.changed).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});

describe('snapshotTopology', () => {
  it('keys nodes by id and keeps only the fields the diff needs', () => {
    const snapshot = snapshotTopology([MASTER_A, REPLICA_B]);

    expect([...snapshot.keys()].sort()).toEqual(['a', 'b']);
    expect(snapshot.get('b')).toEqual({
      role: 'replica',
      masterId: 'a',
      configEpoch: 1,
    });
  });

  it("drops a master's masterId, which CLUSTER NODES reports as a placeholder", () => {
    expect(snapshotTopology([MASTER_A]).get('a')?.masterId).toBeUndefined();
  });

  it('skips an entry that is neither master nor replica', () => {
    const handshake = node({ id: 'h', flags: ['handshake'] });

    expect(snapshotTopology([MASTER_A, handshake]).has('h')).toBe(false);
  });
});

describe('roleFromFlags', () => {
  it.each([
    [['master', 'myself'], 'master'],
    [['slave'], 'replica'],
    [['replica'], 'replica'],
    [['handshake'], null],
    [['noaddr'], null],
  ])('maps %j to %s', (flags, expected) => {
    expect(roleFromFlags(flags as string[])).toBe(expected);
  });
});
