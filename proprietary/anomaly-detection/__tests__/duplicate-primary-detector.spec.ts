import { ClusterNode } from '@app/common/types/metrics.types';
import {
  detectDuplicatePrimaries,
  firstOverlappingRange,
  conflictSignature,
} from '../duplicate-primary-detector';

/** Build a minimal ClusterNode for tests. */
function node(partial: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'flags' | 'slots'>): ClusterNode {
  return {
    address: `127.0.0.1:6379@16379`,
    master: '',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 0,
    linkState: 'connected',
    ...partial,
  };
}

describe('firstOverlappingRange', () => {
  it('returns null for disjoint ranges', () => {
    expect(firstOverlappingRange([[0, 100]], [[101, 200]])).toBeNull();
  });

  it('returns the overlapping segment for identical ranges', () => {
    expect(firstOverlappingRange([[0, 5461]], [[0, 5461]])).toEqual([0, 5461]);
  });

  it('returns the intersection for partially overlapping ranges', () => {
    expect(firstOverlappingRange([[0, 100]], [[50, 200]])).toEqual([50, 100]);
  });

  it('handles multiple ranges and returns the first overlap found', () => {
    expect(firstOverlappingRange([[0, 10], [100, 200]], [[150, 160]])).toEqual([150, 160]);
  });
});

describe('detectDuplicatePrimaries', () => {
  it('returns no conflicts for a healthy cluster (disjoint primaries)', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], slots: [[0, 5460]], configEpoch: 1 }),
      node({ id: 'b', flags: ['master'], slots: [[5461, 10922]], configEpoch: 2 }),
      node({ id: 'c', flags: ['master'], slots: [[10923, 16383]], configEpoch: 3 }),
    ];
    expect(detectDuplicatePrimaries(nodes)).toHaveLength(0);
  });

  it('does not flag a primary with its replicas as a conflict', () => {
    const nodes = [
      node({ id: 'primary', flags: ['master'], slots: [[0, 16383]], configEpoch: 5 }),
      // Replicas carry no slots and are not master-flagged.
      node({ id: 'replica1', flags: ['slave'], master: 'primary', slots: [], configEpoch: 5 }),
      node({ id: 'replica2', flags: ['replica'], master: 'primary', slots: [], configEpoch: 5 }),
    ];
    expect(detectDuplicatePrimaries(nodes)).toHaveLength(0);
  });

  it('detects two primaries claiming the same slots and names the phantom (lower epoch)', () => {
    const nodes = [
      // Node A: stale primary, still thinks it owns the slots, lower configEpoch.
      node({ id: 'nodeAAAAAAAA', address: '10.0.0.1:6379@16379', flags: ['myself', 'master'], slots: [[0, 5460]], configEpoch: 4 }),
      // Node C: authoritative primary, higher configEpoch.
      node({ id: 'nodeCCCCCCCC', address: '10.0.0.3:6379@16379', flags: ['master'], slots: [[0, 5460]], configEpoch: 9 }),
    ];

    const conflicts = detectDuplicatePrimaries(nodes);
    expect(conflicts).toHaveLength(1);

    const conflict = conflicts[0];
    expect(conflict.slotStart).toBe(0);
    expect(conflict.slotEnd).toBe(5460);
    // Phantom is the lower-epoch primary.
    expect(conflict.phantomId).toBe('nodeAAAAAAAA');
    // Authoritative (higher epoch) is listed first.
    expect(conflict.masters[0].id).toBe('nodeCCCCCCCC');
    expect(conflict.masters[0].configEpoch).toBe(9);
    expect(conflict.masters[1].id).toBe('nodeAAAAAAAA');
  });

  it('does not flag two primaries that own different slots even if one is stale', () => {
    const nodes = [
      node({ id: 'a', flags: ['master'], slots: [[0, 5460]], configEpoch: 1 }),
      node({ id: 'b', flags: ['master'], slots: [[5461, 16383]], configEpoch: 2 }),
    ];
    expect(detectDuplicatePrimaries(nodes)).toHaveLength(0);
  });

  it('ignores master-flagged nodes that own no slots', () => {
    const nodes = [
      node({ id: 'a', flags: ['master'], slots: [[0, 16383]], configEpoch: 3 }),
      // A freshly-restarted primary that has not been assigned slots yet.
      node({ id: 'b', flags: ['master'], slots: [], configEpoch: 0 }),
    ];
    expect(detectDuplicatePrimaries(nodes)).toHaveLength(0);
  });

  it('does not flag a normal failover: old primary still lists slots as master,fail', () => {
    const nodes = [
      // Old primary: transiently down but its CLUSTER NODES entry still lists the slots.
      node({ id: 'old', flags: ['master', 'fail'], slots: [[0, 5460]], configEpoch: 4 }),
      // Just-promoted replica now owns the same slots as a healthy master.
      node({ id: 'new', flags: ['master'], slots: [[0, 5460]], configEpoch: 5 }),
    ];
    expect(detectDuplicatePrimaries(nodes)).toHaveLength(0);
  });

  it('ignores primaries in fail?/handshake/noaddr transient states', () => {
    const healthy = node({ id: 'ok', flags: ['master'], slots: [[0, 5460]], configEpoch: 5 });
    for (const flag of ['fail?', 'handshake', 'noaddr']) {
      const transient = node({ id: 't', flags: ['master', flag], slots: [[0, 5460]], configEpoch: 4 });
      expect(detectDuplicatePrimaries([transient, healthy])).toHaveLength(0);
    }
  });

  it('still flags a genuine split-brain where both primaries are healthy', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], slots: [[0, 5460]], configEpoch: 4 }),
      node({ id: 'b', flags: ['master'], slots: [[0, 5460]], configEpoch: 9 }),
    ];
    expect(detectDuplicatePrimaries(nodes)).toHaveLength(1);
  });
});

describe('conflictSignature', () => {
  it('is stable regardless of primary ordering', () => {
    const base = {
      slotStart: 0,
      slotEnd: 100,
      phantomId: 'a',
      masters: [
        { id: 'a', address: 'x', configEpoch: 1 },
        { id: 'b', address: 'y', configEpoch: 2 },
      ] as any,
    };
    const swapped = {
      ...base,
      masters: [
        { id: 'b', address: 'y', configEpoch: 2 },
        { id: 'a', address: 'x', configEpoch: 1 },
      ] as any,
    };
    expect(conflictSignature(base)).toBe(conflictSignature(swapped));
  });
});
