import { ClusterNode } from '@app/common/types/metrics.types';
import {
  RESYNC_LOOP_MIN_CYCLES,
  RESYNC_LOOP_MIN_WINDOW_MS,
  ResyncLoopInput,
  acknowledgeResyncLoopFinding,
  createResyncLoopState,
  detectStuckReplicas,
  evaluateResyncLoop,
  stuckReplicaSignature,
} from '../stuck-replica-detector';

/** Build a minimal ClusterNode for tests. */
function node(partial: Partial<ClusterNode> & Pick<ClusterNode, 'id' | 'flags'>): ClusterNode {
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
    expect(detectStuckReplicas([node({ id: 'solo', flags: ['myself', 'master'] })])).toEqual([]);
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
      replicaId: 'rep',
      replicaAddress: '',
      primaryId: 'p1',
      primaryAddress: null,
      reason: 'primary_unknown',
    });
    const b = stuckReplicaSignature({
      replicaId: 'rep',
      replicaAddress: '',
      primaryId: 'p2',
      primaryAddress: null,
      reason: 'primary_unknown',
    });
    expect(a).not.toBe(b);
  });
});

describe('evaluateResyncLoop', () => {
  const base = 1_700_000_000_000;
  const POLL_MS = 10_000;

  function replInput(over: Partial<ResyncLoopInput> = {}): ResyncLoopInput {
    return {
      role: 'slave',
      masterLinkStatus: 'down',
      masterLinkDownSinceSeconds: 30,
      masterSyncInProgress: true,
      syncFull: 0,
      timestamp: base,
      ...over,
    };
  }

  /** Polls until past the minimum window, `mutate` shaping each poll's input. */
  function pollThroughWindow(
    state: ReturnType<typeof createResyncLoopState>,
    mutate: (pollIndex: number) => Partial<ResyncLoopInput>,
  ): ReturnType<typeof evaluateResyncLoop> {
    const polls = Math.ceil(RESYNC_LOOP_MIN_WINDOW_MS / POLL_MS) + 2;
    let finding: ReturnType<typeof evaluateResyncLoop> = null;
    for (let i = 0; i <= polls; i++) {
      finding = evaluateResyncLoop(
        state,
        replInput({
          timestamp: base + i * POLL_MS,
          masterLinkDownSinceSeconds: 30 + (i * POLL_MS) / 1000,
          ...mutate(i),
        }),
      );
    }
    return finding;
  }

  it('stays silent through a healthy first full sync of a large dataset', () => {
    const state = createResyncLoopState();
    // Link held down for the whole window while ONE sync attempt keeps
    // transferring: sync counter never moves, sync stays in progress.
    const finding = pollThroughWindow(state, () => {
      return { syncFull: 5, masterSyncInProgress: true };
    });
    expect(finding).toBeNull();
  });

  it('fires after at least two failed full-sync cycles across the minimum window', () => {
    const state = createResyncLoopState();
    // sync_full climbs on every 10th poll: repeated full-sync attempts while
    // the link never reaches up.
    const finding = pollThroughWindow(state, (i) => {
      return { syncFull: 5 + Math.floor(i / 10) };
    });
    expect(finding).not.toBeNull();
    expect(finding!.failedCycles).toBeGreaterThanOrEqual(RESYNC_LOOP_MIN_CYCLES);
    expect(finding!.downSeconds).toBeGreaterThanOrEqual(RESYNC_LOOP_MIN_WINDOW_MS / 1000);
    expect(finding!.message).toContain('valkey#1836');
    expect(finding!.message).toContain('full');
  });

  it('stays silent before the minimum window even with enough failed cycles', () => {
    const state = createResyncLoopState();
    // Three rapid failed cycles inside the first four polls — still within the
    // window, so nothing may fire yet.
    for (let i = 0; i <= 4; i++) {
      const finding = evaluateResyncLoop(
        state,
        replInput({
          timestamp: base + i * POLL_MS,
          masterLinkDownSinceSeconds: 30 + (i * POLL_MS) / 1000,
          syncFull: 5 + i,
        }),
      );
      expect(finding).toBeNull();
    }
  });

  it('counts a failed cycle from a sync-in-progress toggle when sync_full never moves', () => {
    const state = createResyncLoopState();
    // The counter is flat (leaf replica), but sync repeatedly starts and dies:
    // in-progress toggles 1 → 0 while the link stays down.
    const finding = pollThroughWindow(state, (i) => {
      return { syncFull: 5, masterSyncInProgress: i % 2 === 0 };
    });
    expect(finding).not.toBeNull();
    expect(finding!.failedCycles).toBeGreaterThanOrEqual(RESYNC_LOOP_MIN_CYCLES);
  });

  it('clears on recovery and needs a fresh window + cycles to alert again', () => {
    const state = createResyncLoopState();
    const firstLoop = pollThroughWindow(state, (i) => {
      return { syncFull: 5 + i };
    });
    expect(firstLoop).not.toBeNull();
    acknowledgeResyncLoopFinding(state);

    // The replica recovers: link up. State clears.
    const recoveredAt = base + 1_000_000;
    expect(
      evaluateResyncLoop(
        state,
        replInput({
          masterLinkStatus: 'up',
          masterLinkDownSinceSeconds: null,
          masterSyncInProgress: false,
          syncFull: 40,
          timestamp: recoveredAt,
        }),
      ),
    ).toBeNull();

    // A new loop must earn the window again: cycles right away, but silent
    // until the fresh window has elapsed...
    expect(
      evaluateResyncLoop(
        state,
        replInput({
          syncFull: 41,
          masterLinkDownSinceSeconds: 10,
          timestamp: recoveredAt + POLL_MS,
        }),
      ),
    ).toBeNull();
    expect(
      evaluateResyncLoop(
        state,
        replInput({
          syncFull: 42,
          masterLinkDownSinceSeconds: 20,
          timestamp: recoveredAt + 2 * POLL_MS,
        }),
      ),
    ).toBeNull();
    // ...and then it alerts again (recovery re-armed the alert).
    const secondLoop = evaluateResyncLoop(
      state,
      replInput({
        syncFull: 43,
        masterLinkDownSinceSeconds: 20 + RESYNC_LOOP_MIN_WINDOW_MS / 1000,
        timestamp: recoveredAt + POLL_MS + RESYNC_LOOP_MIN_WINDOW_MS,
      }),
    );
    expect(secondLoop).not.toBeNull();
  });

  it('keeps returning the finding until acknowledged, then stays quiet while the loop persists', () => {
    const state = createResyncLoopState();
    const finding = pollThroughWindow(state, (i) => {
      return { syncFull: 5 + i };
    });
    expect(finding).not.toBeNull();
    // Unacknowledged (emit failed): re-produced next poll.
    const retry = evaluateResyncLoop(
      state,
      replInput({
        timestamp: base + 2_000_000,
        masterLinkDownSinceSeconds: 2_100,
        syncFull: 100,
      }),
    );
    expect(retry).not.toBeNull();
    acknowledgeResyncLoopFinding(state);
    // Acknowledged: the continuing loop stays quiet.
    expect(
      evaluateResyncLoop(
        state,
        replInput({
          timestamp: base + 2_010_000,
          masterLinkDownSinceSeconds: 2_110,
          syncFull: 101,
        }),
      ),
    ).toBeNull();
  });

  it('resets when the instance is not a replica', () => {
    const state = createResyncLoopState();
    for (let i = 0; i <= 4; i++) {
      evaluateResyncLoop(state, replInput({ timestamp: base + i * POLL_MS, syncFull: 5 + i }));
    }
    // Promotion (or a non-replica connection): clears everything.
    expect(
      evaluateResyncLoop(
        state,
        replInput({
          role: 'master',
          masterLinkStatus: null,
          masterLinkDownSinceSeconds: null,
          syncFull: 10,
          timestamp: base + 5 * POLL_MS,
        }),
      ),
    ).toBeNull();
    // Back to replica with cycles but a fresh window: silent.
    const afterReset = pollThroughWindow(state, (i) => {
      return { syncFull: 20 + i, timestamp: base + 1_000_000 + i * POLL_MS };
    });
    // Fires only because the FRESH window fully elapsed again.
    expect(afterReset).not.toBeNull();
  });

  it('restarts the window when master_link_down_since_seconds drops (link was briefly up)', () => {
    const state = createResyncLoopState();
    const polls = Math.ceil(RESYNC_LOOP_MIN_WINDOW_MS / POLL_MS) + 2;
    let finding: ReturnType<typeof evaluateResyncLoop> = null;
    for (let i = 0; i <= polls; i++) {
      finding = evaluateResyncLoop(
        state,
        replInput({
          timestamp: base + i * POLL_MS,
          // A successful reconnect midway resets the server-side down counter:
          // the link DID reach up, so this is not a never-completing loop.
          masterLinkDownSinceSeconds: i < polls - 1 ? 30 + i * 10 : 5,
          syncFull: 5 + i,
        }),
      );
    }
    expect(finding).toBeNull();
  });
});
