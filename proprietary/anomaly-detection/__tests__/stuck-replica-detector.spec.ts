import { ClusterNode } from '@app/common/types/metrics.types';
import {
  detectStuckReplicas,
  stuckReplicaSignature,
} from '../stuck-replica-detector';

/** Build a minimal ClusterNode for tests. */
function node(
  partial: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'flags'>,
): ClusterNode {
  return {
    address: '127.0.0.1:6379@16379',
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 0,
    linkState: 'connected',
    slots: [],
    ...partial,
  };
}

describe('detectStuckReplicas', () => {
  it('returns nothing for a healthy shard (replica with a live primary)', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({ id: 'rep', flags: ['slave'], master: 'prim' }),
    ];
    expect(detectStuckReplicas(nodes)).toEqual([]);
  });

  it('returns nothing for an all-primaries (no replica) cluster', () => {
    const nodes = [
      node({ id: 'a', flags: ['master'], slots: [[0, 8191]] }),
      node({ id: 'b', flags: ['master'], slots: [[8192, 16383]] }),
    ];
    expect(detectStuckReplicas(nodes)).toEqual([]);
  });

  it('returns nothing for a non-cluster / empty view', () => {
    expect(detectStuckReplicas([])).toEqual([]);
    expect(
      detectStuckReplicas([node({ id: 'solo', flags: ['myself', 'master'] })]),
    ).toEqual([]);
  });

  // The core valkey#2090 state, taken from the issue's own CLUSTER NODES dump on
  // the surviving replica (port 6380): the replica still replicates the old
  // primary (8f53…), which is now master,fail,noaddr, while a fresh primary
  // (c499…) has taken over — the replica never adopts it.
  it('flags the orphaned replica from the valkey#2090 reproduction', () => {
    const nodes = [
      node({
        id: 'c499ec449c7627bca31a1e6ed6471a972b72722d',
        address: '127.0.0.1:6379@16379',
        flags: ['master'],
      }),
      node({
        id: '3dbc6e48fa18eb10360e0987258692507edb2fd2',
        address: '127.0.0.1:6380@16380',
        flags: ['myself', 'slave'],
        master: '8f53613474ab558fc6f0bdd6e86ec550435199bb',
      }),
      node({
        id: '8f53613474ab558fc6f0bdd6e86ec550435199bb',
        address: ':0@0',
        flags: ['master', 'fail', 'noaddr'],
      }),
    ];

    const stuck = detectStuckReplicas(nodes);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({
      replicaId: '3dbc6e48fa18eb10360e0987258692507edb2fd2',
      primaryId: '8f53613474ab558fc6f0bdd6e86ec550435199bb',
      primaryAddress: ':0@0',
      reason: 'primary_failed',
    });
  });

  it("reports 'primary_unknown' when the replica's primary is absent from the view", () => {
    const nodes = [
      node({ id: 'rep', flags: ['slave'], master: 'ghost-primary-id' }),
      node({ id: 'other', flags: ['master'], slots: [[0, 16383]] }),
    ];
    const stuck = detectStuckReplicas(nodes);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({
      replicaId: 'rep',
      primaryId: 'ghost-primary-id',
      primaryAddress: null,
      reason: 'primary_unknown',
    });
  });

  it("flags a primary in 'fail?' (probable-fail) state", () => {
    const nodes = [
      node({ id: 'prim', flags: ['master', 'fail?'] }),
      node({ id: 'rep', flags: ['slave'], master: 'prim' }),
    ];
    const stuck = detectStuckReplicas(nodes);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('primary_failed');
  });

  it('accepts the newer "replica" flag as well as legacy "slave"', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master', 'fail'] }),
      node({ id: 'rep', flags: ['replica'], master: 'prim' }),
    ];
    expect(detectStuckReplicas(nodes)).toHaveLength(1);
  });

  it('reports each orphaned replica independently', () => {
    const nodes = [
      node({ id: 'deadprim', flags: ['master', 'fail', 'noaddr'] }),
      node({ id: 'rep1', flags: ['slave'], master: 'deadprim' }),
      node({ id: 'rep2', flags: ['slave'], master: 'deadprim' }),
      node({ id: 'liveprim', flags: ['master'], slots: [[0, 16383]] }),
      node({ id: 'rep3', flags: ['slave'], master: 'liveprim' }), // healthy
    ];
    const stuck = detectStuckReplicas(nodes);
    expect(stuck.map((s) => s.replicaId).sort()).toEqual(['rep1', 'rep2']);
  });
});

describe('stuckReplicaSignature', () => {
  it('is stable for the same (replica, primary) pair', () => {
    const base = {
      replicaId: 'rep',
      replicaAddress: 'a',
      primaryId: 'prim',
      primaryAddress: 'b',
      reason: 'primary_failed' as const,
    };
    expect(stuckReplicaSignature(base)).toBe('rep|prim');
    // Same pair, different observed addresses / reason → same signature.
    expect(
      stuckReplicaSignature({ ...base, primaryAddress: null, reason: 'primary_unknown' }),
    ).toBe('rep|prim');
  });

  it('differs when the replica re-points at a new primary', () => {
    const a = stuckReplicaSignature({
      replicaId: 'rep', replicaAddress: '', primaryId: 'p1', primaryAddress: null, reason: 'primary_unknown',
    });
    const b = stuckReplicaSignature({
      replicaId: 'rep', replicaAddress: '', primaryId: 'p2', primaryAddress: null, reason: 'primary_unknown',
    });
    expect(a).not.toBe(b);
  });
});
