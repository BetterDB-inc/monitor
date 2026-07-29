import { ClusterNode } from '@app/common/types/metrics.types';
import {
  FAILOVER_CHURN_MIN_CHANGES,
  FAILOVER_CHURN_WINDOW_MS,
  FailoverChurnStateMap,
  acknowledgeChurnFinding,
  evaluateFailoverChurn,
  extractShardOwnership,
} from '../failover-churn-detector';

function node(over: Partial<ClusterNode> & { id: string }): ClusterNode {
  return {
    address: `10.0.0.${over.id.length}:6379@16379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 5460]],
    ...over,
  };
}

function replica(id: string, masterId: string): ClusterNode {
  return node({ id, flags: ['slave'], master: masterId, slots: [], configEpoch: 0 });
}

describe('extractShardOwnership', () => {
  it('maps a live primary to a shard keyed by its canonical slot ranges', () => {
    const shards = extractShardOwnership([
      node({
        id: 'a',
        slots: [
          [5461, 10922],
          [0, 5460],
        ],
        configEpoch: 7,
      }),
      replica('r1', 'a'),
    ]);
    expect(shards).toHaveLength(1);
    expect(shards[0]).toMatchObject({
      shardKey: '0-5460,5461-10922',
      ownerId: 'a',
      configEpoch: 7,
      resharding: false,
    });
  });

  it('ignores replicas, slotless masters, and transient/unhealthy nodes', () => {
    const shards = extractShardOwnership([
      node({ id: 'dying', flags: ['master', 'fail'], configEpoch: 3 }),
      node({ id: 'shy', flags: ['master', 'handshake'], configEpoch: 4 }),
      node({ id: 'slotless', slots: [], configEpoch: 5 }),
      replica('r1', 'dying'),
    ]);
    expect(shards).toHaveLength(0);
  });

  it('attributes a contested shard to the highest-epoch live primary', () => {
    const shards = extractShardOwnership([
      node({ id: 'stale', configEpoch: 4 }),
      node({ id: 'authoritative', configEpoch: 9 }),
    ]);
    expect(shards).toHaveLength(1);
    expect(shards[0].ownerId).toBe('authoritative');
    expect(shards[0].configEpoch).toBe(9);
  });

  it('breaks an equal-epoch contest by lexically smallest node id, regardless of line order', () => {
    const forward = extractShardOwnership([
      node({ id: 'aaa', configEpoch: 7 }),
      node({ id: 'bbb', configEpoch: 7 }),
    ]);
    const reversed = extractShardOwnership([
      node({ id: 'bbb', configEpoch: 7 }),
      node({ id: 'aaa', configEpoch: 7 }),
    ]);
    expect(forward[0].ownerId).toBe('aaa');
    expect(reversed[0].ownerId).toBe('aaa');
  });

  it('flags a shard as resharding when its owner is migrating or importing slots', () => {
    const shards = extractShardOwnership([
      node({
        id: 'a',
        configEpoch: 7,
        migratingSlots: [{ slot: 42, targetNodeId: 'b' }],
      }),
    ]);
    expect(shards).toHaveLength(1);
    expect(shards[0].resharding).toBe(true);
  });
});

describe('evaluateFailoverChurn', () => {
  const base = 1_700_000_000_000;

  function snapshotAt(
    state: FailoverChurnStateMap,
    epoch: number,
    owner: string,
    at: number,
    over: Partial<ClusterNode> = {},
  ) {
    return evaluateFailoverChurn(
      state,
      [node({ id: owner, configEpoch: epoch, ...over }), replica('r1', owner)],
      at,
    );
  }

  it('never fires on a single clean failover (one epoch bump + one owner change)', () => {
    const state: FailoverChurnStateMap = new Map();
    expect(snapshotAt(state, 5, 'a', base)).toHaveLength(0);
    expect(snapshotAt(state, 6, 'b', base + 5_000)).toHaveLength(0);
    expect(snapshotAt(state, 6, 'b', base + 10_000)).toHaveLength(0);
  });

  it('fires WARNING when the epoch advances three times inside the window', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 6, 'b', base + 5_000);
    snapshotAt(state, 7, 'a', base + 10_000);
    const findings = snapshotAt(state, 8, 'b', base + 15_000);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].shardKey).toBe('0-5460');
    expect(findings[0].changes).toBe(FAILOVER_CHURN_MIN_CHANGES);
    expect(findings[0].message).toContain('re-elected 3 times');
    expect(findings[0].message).toContain('configEpoch 5→6→7→8');
    expect(findings[0].message).toContain('valkey#3996');
    expect(findings[0].message).toContain('single failover coordinator');
  });

  it('does not fire when the same churn is spread beyond the window', () => {
    const state: FailoverChurnStateMap = new Map();
    const spacing = FAILOVER_CHURN_WINDOW_MS;
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 6, 'b', base + spacing);
    snapshotAt(state, 7, 'a', base + 2 * spacing);
    expect(snapshotAt(state, 8, 'b', base + 3 * spacing)).toHaveLength(0);
  });

  it('keeps reporting the finding until acknowledged, then requires fresh churn', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 6, 'b', base + 5_000);
    snapshotAt(state, 7, 'a', base + 10_000);
    expect(snapshotAt(state, 8, 'b', base + 15_000)).toHaveLength(1);
    expect(snapshotAt(state, 8, 'b', base + 20_000)).toHaveLength(1);
    acknowledgeChurnFinding(state, '0-5460', base + 20_000);
    expect(snapshotAt(state, 8, 'b', base + 25_000)).toHaveLength(0);
  });

  it('escalates to CRITICAL when churn continues into a second window after a fire', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 6, 'b', base + 5_000);
    snapshotAt(state, 7, 'a', base + 10_000);
    expect(snapshotAt(state, 8, 'b', base + 15_000)[0].severity).toBe('warning');
    acknowledgeChurnFinding(state, '0-5460', base + 15_000);

    snapshotAt(state, 9, 'a', base + 25_000);
    snapshotAt(state, 10, 'b', base + 35_000);
    const findings = snapshotAt(state, 11, 'a', base + 45_000);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('critical');
  });

  it('returns to WARNING when churn resumes long after the last fire', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 6, 'b', base + 5_000);
    snapshotAt(state, 7, 'a', base + 10_000);
    expect(snapshotAt(state, 8, 'b', base + 15_000)[0].severity).toBe('warning');
    acknowledgeChurnFinding(state, '0-5460', base + 15_000);

    const later = base + 15_000 + 3 * FAILOVER_CHURN_WINDOW_MS;
    snapshotAt(state, 9, 'a', later);
    snapshotAt(state, 10, 'b', later + 5_000);
    snapshotAt(state, 11, 'a', later + 10_000);
    const findings = snapshotAt(state, 12, 'b', later + 15_000);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  it('fires on repeated owner flips even without epoch advances', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 5, 'b', base + 5_000);
    snapshotAt(state, 5, 'a', base + 10_000);
    const findings = snapshotAt(state, 5, 'b', base + 15_000);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  it('does not count phantom flips when an equal-epoch contested shard reorders between polls', () => {
    const state: FailoverChurnStateMap = new Map();
    function contestedAt(first: string, second: string, at: number) {
      return evaluateFailoverChurn(
        state,
        [node({ id: first, configEpoch: 7 }), node({ id: second, configEpoch: 7 })],
        at,
      );
    }
    expect(contestedAt('aaa', 'bbb', base)).toHaveLength(0);
    expect(contestedAt('bbb', 'aaa', base + 5_000)).toHaveLength(0);
    expect(contestedAt('aaa', 'bbb', base + 10_000)).toHaveLength(0);
    expect(contestedAt('bbb', 'aaa', base + 15_000)).toHaveLength(0);
  });

  it('does not read a health flap on a different-epoch contested shard as churn', () => {
    const state: FailoverChurnStateMap = new Map();
    function bothLive(at: number) {
      return evaluateFailoverChurn(
        state,
        [node({ id: 'a', configEpoch: 9 }), node({ id: 'b', configEpoch: 4 })],
        at,
      );
    }
    function highEpochFlapping(at: number) {
      return evaluateFailoverChurn(
        state,
        [node({ id: 'a', configEpoch: 9, flags: ['master', 'fail?'] }), node({ id: 'b', configEpoch: 4 })],
        at,
      );
    }
    expect(bothLive(base)).toHaveLength(0);
    expect(highEpochFlapping(base + 5_000)).toHaveLength(0);
    expect(bothLive(base + 10_000)).toHaveLength(0);
    expect(highEpochFlapping(base + 15_000)).toHaveLength(0);
    expect(bothLive(base + 20_000)).toHaveLength(0);
    expect(highEpochFlapping(base + 25_000)).toHaveLength(0);
  });

  it('does not read a health flap on an equal-epoch contested shard as churn', () => {
    const state: FailoverChurnStateMap = new Map();
    function bothLive(at: number) {
      return evaluateFailoverChurn(
        state,
        [node({ id: 'aaa', configEpoch: 7 }), node({ id: 'bbb', configEpoch: 7 })],
        at,
      );
    }
    function preferredFlapping(at: number) {
      return evaluateFailoverChurn(
        state,
        [
          node({ id: 'aaa', configEpoch: 7, flags: ['master', 'fail?'] }),
          node({ id: 'bbb', configEpoch: 7 }),
        ],
        at,
      );
    }
    expect(bothLive(base)).toHaveLength(0);
    expect(preferredFlapping(base + 5_000)).toHaveLength(0);
    expect(bothLive(base + 10_000)).toHaveLength(0);
    expect(preferredFlapping(base + 15_000)).toHaveLength(0);
    expect(bothLive(base + 20_000)).toHaveLength(0);
    expect(preferredFlapping(base + 25_000)).toHaveLength(0);
  });

  it('still fires when a genuine epoch-advancing failover follows a flap', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 9, 'a', base);
    evaluateFailoverChurn(
      state,
      [node({ id: 'a', configEpoch: 9, flags: ['master', 'fail?'] }), node({ id: 'b', configEpoch: 4 })],
      base + 5_000,
    );
    snapshotAt(state, 10, 'b', base + 10_000);
    snapshotAt(state, 11, 'a', base + 15_000);
    const findings = snapshotAt(state, 12, 'b', base + 20_000);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
  });

  it('does not count changes while the shard is resharding', () => {
    const state: FailoverChurnStateMap = new Map();
    const migrating = { migratingSlots: [{ slot: 1, targetNodeId: 'x' }] };
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 6, 'a', base + 5_000, migrating);
    snapshotAt(state, 7, 'a', base + 10_000, migrating);
    snapshotAt(state, 8, 'a', base + 15_000, migrating);
    expect(snapshotAt(state, 9, 'a', base + 20_000, migrating)).toHaveLength(0);
  });

  it('does not count the accumulated epoch delta once resharding markers clear', () => {
    const state: FailoverChurnStateMap = new Map();
    const migrating = { migratingSlots: [{ slot: 1, targetNodeId: 'x' }] };
    snapshotAt(state, 5, 'a', base);
    snapshotAt(state, 8, 'a', base + 5_000, migrating);
    const findings = snapshotAt(state, 8, 'a', base + 10_000);
    expect(findings).toHaveLength(0);
    const st = state.get('0-5460');
    expect(st?.lastEpoch).toBe(8);
  });

  it('a replica flap during normal recovery does not fire', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 5, 'a', base);
    const failingOver = [
      node({ id: 'a', flags: ['master', 'fail'], configEpoch: 5 }),
      node({ id: 'b', configEpoch: 6 }),
    ];
    expect(evaluateFailoverChurn(state, failingOver, base + 5_000)).toHaveLength(0);
    expect(snapshotAt(state, 6, 'b', base + 10_000)).toHaveLength(0);
  });

  it('prunes state for shards that disappear from the topology', () => {
    const state: FailoverChurnStateMap = new Map();
    snapshotAt(state, 5, 'a', base);
    expect(state.has('0-5460')).toBe(true);
    const otherShard = [node({ id: 'z', slots: [[10923, 16383]], configEpoch: 2 })];
    evaluateFailoverChurn(state, otherShard, base + 3 * FAILOVER_CHURN_WINDOW_MS);
    expect(state.has('0-5460')).toBe(false);
  });
});
