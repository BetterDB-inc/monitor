import { ClusterNode, ClusterShard } from '@app/common/types/metrics.types';
import {
  detectReplicaSlotState,
  replicaSlotSignature,
  ReplicaSlotAnomaly,
} from '../replica-slot-state-detector';

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

/** Build a CLUSTER SHARDS shard for tests. */
function shard(slots: number[][], nodes: Array<{ id: string; role: string }>): ClusterShard {
  return { slots, nodes: nodes.map((n) => ({ ...n })) };
}

describe('detectReplicaSlotState', () => {
  it('returns nothing for a healthy shard (replica with no slot state)', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({ id: 'rep', flags: ['slave'], master: 'prim' }),
    ];
    const shards = [shard([[0, 16383]], [{ id: 'prim', role: 'master' }, { id: 'rep', role: 'replica' }])];
    expect(detectReplicaSlotState(nodes, shards)).toEqual([]);
  });

  it('flags a replica reporting a slot in IMPORTING state', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({
        id: 'rep',
        flags: ['slave'],
        master: 'prim',
        importingSlots: [{ slot: 42, sourceNodeId: 'prim' }],
      }),
    ];
    const found = detectReplicaSlotState(nodes);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      replicaId: 'rep',
      reason: 'replica_importing',
      affectedSlots: [42],
    });
  });

  it('flags a replica reporting a slot in MIGRATING state', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({
        id: 'rep',
        flags: ['replica'],
        master: 'prim',
        migratingSlots: [
          { slot: 7, targetNodeId: 'other' },
          { slot: 3, targetNodeId: 'other' },
        ],
      }),
    ];
    const found = detectReplicaSlotState(nodes);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ replicaId: 'rep', reason: 'replica_migrating' });
    // Slots are sorted ascending and de-duplicated.
    expect(found[0].affectedSlots).toEqual([3, 7]);
  });

  it('ignores a PRIMARY that legitimately carries slot-migration state', () => {
    const nodes = [
      node({
        id: 'prim',
        flags: ['master'],
        slots: [[0, 16383]],
        migratingSlots: [{ slot: 42, targetNodeId: 'other' }],
      }),
      node({ id: 'rep', flags: ['slave'], master: 'prim' }),
    ];
    expect(detectReplicaSlotState(nodes)).toEqual([]);
  });

  it('suppresses the alert when CLUSTER SHARDS says the node is actually a master (mid-promotion)', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({
        id: 'rep',
        flags: ['slave'], // NODES flag is stale
        master: 'prim',
        importingSlots: [{ slot: 42, sourceNodeId: 'prim' }],
      }),
    ];
    // SHARDS authority: 'rep' is really the master of the shard now.
    const shards = [shard([[0, 16383]], [{ id: 'prim', role: 'replica' }, { id: 'rep', role: 'master' }])];
    expect(detectReplicaSlotState(nodes, shards)).toEqual([]);
  });

  it('flags slot-view divergence: a replica owning slots per CLUSTER SHARDS', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      // A replica should never own slots in CLUSTER NODES.
      node({ id: 'rep', flags: ['slave'], master: 'prim', slots: [[100, 200]] }),
    ];
    const shards = [shard([[0, 16383]], [{ id: 'prim', role: 'master' }, { id: 'rep', role: 'replica' }])];
    const found = detectReplicaSlotState(nodes, shards);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      replicaId: 'rep',
      reason: 'slot_view_divergence',
      // Signature carries both bounds so a range change re-alerts (not just start).
      affectedSlots: [100, 200],
      ownedSlots: [[100, 200]],
      shardId: 'prim',
      shardSlots: [[0, 16383]],
    });
  });

  it('re-signatures a divergence when the owned range changes but keeps its start', () => {
    const shards = [shard([[0, 16383]], [{ id: 'prim', role: 'master' }, { id: 'rep', role: 'replica' }])];
    const sigFor = (ownedEnd: number) => {
      const nodes = [
        node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
        node({ id: 'rep', flags: ['slave'], master: 'prim', slots: [[100, ownedEnd]] }),
      ];
      return replicaSlotSignature(detectReplicaSlotState(nodes, shards)[0]);
    };
    expect(sigFor(200)).not.toBe(sigFor(16000));
  });

  it('does not run the divergence check without CLUSTER SHARDS (Layer 1 only)', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({ id: 'rep', flags: ['slave'], master: 'prim', slots: [[100, 200]] }),
    ];
    // No shards → owning-slots divergence is not evaluated.
    expect(detectReplicaSlotState(nodes)).toEqual([]);
  });

  it('still detects migrating/importing on CLUSTER NODES alone (degrade path)', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({
        id: 'rep',
        flags: ['slave'],
        master: 'prim',
        importingSlots: [{ slot: 42, sourceNodeId: 'prim' }],
      }),
    ];
    const found = detectReplicaSlotState(nodes);
    expect(found).toHaveLength(1);
    expect(found[0].reason).toBe('replica_importing');
    // No shard attribution available on the degrade path.
    expect(found[0].shardId).toBeUndefined();
  });

  it('attaches shard attribution when CLUSTER SHARDS is present', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({
        id: 'rep',
        flags: ['slave'],
        master: 'prim',
        migratingSlots: [{ slot: 5, targetNodeId: 'other' }],
      }),
    ];
    const shards = [shard([[0, 16383]], [{ id: 'prim', role: 'master' }, { id: 'rep', role: 'replica' }])];
    const found = detectReplicaSlotState(nodes, shards);
    expect(found[0].shardId).toBe('prim');
    expect(found[0].shardSlots).toEqual([[0, 16383]]);
  });

  it('reports each offending replica independently', () => {
    const nodes = [
      node({ id: 'prim', flags: ['master'], slots: [[0, 16383]] }),
      node({ id: 'r1', flags: ['slave'], master: 'prim', importingSlots: [{ slot: 1, sourceNodeId: 'prim' }] }),
      node({ id: 'r2', flags: ['slave'], master: 'prim', migratingSlots: [{ slot: 2, targetNodeId: 'x' }] }),
      node({ id: 'r3', flags: ['slave'], master: 'prim' }), // healthy
    ];
    const found = detectReplicaSlotState(nodes);
    expect(found.map((a) => a.replicaId).sort()).toEqual(['r1', 'r2']);
  });
});

describe('replicaSlotSignature', () => {
  const base: ReplicaSlotAnomaly = {
    replicaId: 'rep',
    replicaAddress: 'a',
    reason: 'replica_importing',
    affectedSlots: [1, 2],
  };

  it('is stable for the same (replica, reason, slots)', () => {
    expect(replicaSlotSignature(base)).toBe('rep|replica_importing|1,2');
    // Attribution/address changes don't affect the signature.
    expect(replicaSlotSignature({ ...base, replicaAddress: 'b', shardId: 'x' })).toBe(
      'rep|replica_importing|1,2',
    );
  });

  it('differs by reason and by the set of affected slots', () => {
    expect(replicaSlotSignature({ ...base, reason: 'replica_migrating' })).not.toBe(
      replicaSlotSignature(base),
    );
    expect(replicaSlotSignature({ ...base, affectedSlots: [1, 3] })).not.toBe(
      replicaSlotSignature(base),
    );
  });
});
