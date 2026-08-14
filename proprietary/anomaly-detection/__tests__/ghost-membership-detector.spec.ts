import { ClusterNode } from '@app/common/types/metrics.types';
import {
  canonicalEndpoint,
  detectGhostMembers,
  ghostMemberSignature,
} from '../ghost-membership-detector';

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

describe('canonicalEndpoint', () => {
  it('strips the cluster-bus @cport suffix', () => {
    expect(canonicalEndpoint('10.0.0.1:6379@16379')).toBe('10.0.0.1:6379');
  });

  it('returns empty for a hostless (noaddr / :0) address', () => {
    expect(canonicalEndpoint(':0@0')).toBe('');
    expect(canonicalEndpoint('')).toBe('');
  });

  it('keeps compressed IPv6 hosts (leading ::) instead of dropping them', () => {
    expect(canonicalEndpoint('::1:6379@16379')).toBe('::1:6379');
    expect(canonicalEndpoint('2001:db8::1:6379@16379')).toBe('2001:db8::1:6379');
    expect(canonicalEndpoint('[::1]:6379@16379')).toBe('[::1]:6379');
  });
});

describe('detectGhostMembers', () => {
  it('returns nothing for a healthy cluster (one id per endpoint)', () => {
    const nodes = [
      node({
        id: 'a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        slots: [[0, 8191]],
      }),
      node({ id: 'b', flags: ['master'], address: '10.0.0.2:6379@16379', slots: [[8192, 16383]] }),
      node({ id: 'r', flags: ['slave'], master: 'b', address: '10.0.0.3:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('returns nothing for a node that failed and recovered under its SAME id', () => {
    // Same endpoint, same id — a single-id endpoint, not a ghost.
    const nodes = [
      node({
        id: 'a',
        flags: ['master', 'fail'],
        address: '10.0.0.1:6379@16379',
        slots: [[0, 16383]],
      }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('detects a HARD-reset ghost: old id lingers as fail, new id occupies the endpoint', () => {
    const nodes = [
      node({
        id: 'old-ghost-id',
        flags: ['master', 'fail'],
        address: '10.0.0.1:6379@16379',
        slots: [[0, 5460]],
        configEpoch: 5,
      }),
      node({
        id: 'new-live-id',
        flags: ['master'],
        address: '10.0.0.1:6379@16379',
        configEpoch: 0,
      }),
      node({
        id: 'other',
        flags: ['myself', 'master'],
        address: '10.0.0.2:6379@16379',
        slots: [[5461, 16383]],
      }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      endpoint: '10.0.0.1:6379',
      ghostIds: ['old-ghost-id'],
      liveId: 'new-live-id',
    });
  });

  it('prefers an established occupant over a still-handshaking twin as the live id', () => {
    const nodes = [
      node({ id: 'ghost', flags: ['noaddr', 'master'], address: '10.0.0.1:6379@16379' }),
      node({
        id: 'established',
        flags: ['master'],
        address: '10.0.0.1:6379@16379',
        linkState: 'connected',
      }),
      node({ id: 'joining', flags: ['handshake'], address: '10.0.0.1:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].liveId).toBe('established');
    expect(findings[0].ghostIds).toEqual(['ghost']);
  });

  it('falls back to a handshaking twin when the only live id is still joining', () => {
    const nodes = [
      node({ id: 'ghost', flags: ['master', 'fail?'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'rejoining', flags: ['handshake'], address: '10.0.0.1:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].liveId).toBe('rejoining');
    expect(findings[0].ghostIds).toEqual(['ghost']);
  });

  it('does not fire when every id on an endpoint is a ghost (fully-dead node, no live twin)', () => {
    const nodes = [
      node({ id: 'dead1', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'dead2', flags: ['master', 'noaddr'], address: '10.0.0.1:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('does not fire on a normal failover (promoted replica lives at a DIFFERENT endpoint)', () => {
    const nodes = [
      node({
        id: 'old-prim',
        flags: ['master', 'fail'],
        address: '10.0.0.1:6379@16379',
        slots: [[0, 16383]],
      }),
      node({
        id: 'promoted',
        flags: ['master'],
        address: '10.0.0.2:6379@16379',
        slots: [[0, 16383]],
      }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('aggregates multiple ghosts on one endpoint into a single finding', () => {
    const nodes = [
      node({ id: 'ghost-a', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'ghost-b', flags: ['noaddr', 'master'], address: '10.0.0.1:6379@16379' }),
      node({
        id: 'live',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        slots: [[0, 16383]],
      }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].ghostIds).toEqual(['ghost-a', 'ghost-b']); // sorted
    expect(findings[0].liveId).toBe('live');
  });

  it('detects a ghost on a compressed IPv6 endpoint', () => {
    const nodes = [
      node({ id: 'ghost', flags: ['master', 'fail'], address: '::1:6379@16379' }),
      node({
        id: 'live',
        flags: ['myself', 'master'],
        address: '::1:6379@16379',
        slots: [[0, 16383]],
      }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      endpoint: '::1:6379',
      ghostIds: ['ghost'],
      liveId: 'live',
    });
  });

  it('produces a stable, order-independent signature', () => {
    const g1 = detectGhostMembers([
      node({ id: 'ghost', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live', flags: ['master'], address: '10.0.0.1:6379@16379' }),
    ])[0];
    const g2 = detectGhostMembers([
      node({ id: 'live', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'ghost', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
    ])[0];
    expect(ghostMemberSignature(g1)).toBe(ghostMemberSignature(g2));
  });
});

describe('detectGhostMembers — live endpoint collision (valkey#2768)', () => {
  it('detects two LIVE ids advertising the same ip:port', () => {
    const nodes = [
      node({
        id: 'live-a',
        flags: ['myself', 'master'],
        address: '10.0.0.1:6379@16379',
        slots: [[0, 8191]],
      }),
      node({
        id: 'live-b',
        flags: ['master'],
        address: '10.0.0.1:6379@16379',
        slots: [[8192, 16383]],
      }),
      node({ id: 'other', flags: ['master'], address: '10.0.0.2:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reason: 'live_endpoint_collision',
      endpoint: '10.0.0.1:6379',
      collidingIds: ['live-a', 'live-b'],
      ghostIds: [],
    });
  });

  it('leaves the dead-twin path untouched when one id is a ghost', () => {
    const nodes = [
      node({ id: 'old-ghost-id', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'new-live-id', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'other', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reason: 'stale_twin',
      ghostIds: ['old-ghost-id'],
      liveId: 'new-live-id',
    });
  });

  it('reports both reasons when a ghost AND two live ids share one endpoint', () => {
    const nodes = [
      node({ id: 'ghost', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-a', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-b', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'other', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
    ];
    const reasons = detectGhostMembers(nodes)
      .map((f) => {
        return f.reason;
      })
      .sort();
    expect(reasons).toEqual(['live_endpoint_collision', 'stale_twin']);
  });

  it('does not fire on a healthy cluster where every endpoint is unique', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'b', flags: ['master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'c', flags: ['slave'], master: 'b', address: '10.0.0.3:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('no-ops for a standalone node (single-node view, unique endpoint)', () => {
    const nodes = [
      node({ id: 'solo', flags: ['myself', 'master'], address: '10.0.0.1:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });
});

describe('detectGhostMembers — loopback address flip (valkey#2768)', () => {
  it('flags a node that flipped to 127.0.0.1 among routable peers', () => {
    const nodes = [
      node({ id: 'flipped', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'ok-a', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok-b', flags: ['master'], address: '10.0.0.3:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      reason: 'loopback_flip',
      endpoint: '127.0.0.1:6379',
      liveId: 'flipped',
    });
  });

  it('flags ::1 and localhost the same way', () => {
    const v6 = detectGhostMembers([
      node({ id: 'flipped', flags: ['master'], address: '::1:6379@16379' }),
      node({ id: 'ok', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok2', flags: ['master'], address: '10.0.0.3:6379@16379' }),
    ]);
    expect(v6).toHaveLength(1);
    expect(v6[0].reason).toBe('loopback_flip');

    const named = detectGhostMembers([
      node({ id: 'flipped', flags: ['master'], address: 'localhost:6379@16379' }),
      node({ id: 'ok', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok2', flags: ['master'], address: '10.0.0.3:6379@16379' }),
    ]);
    expect(named).toHaveLength(1);
    expect(named[0].reason).toBe('loopback_flip');
  });

  it('stays silent on an all-loopback cluster (local dev), where no peer is routable', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '127.0.0.1:7000@17000' }),
      node({ id: 'b', flags: ['master'], address: '127.0.0.1:7001@17001' }),
      node({ id: 'c', flags: ['slave'], master: 'b', address: '127.0.0.1:7002@17002' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('supersedes the plain collision reason when the shared endpoint is loopback', () => {
    const nodes = [
      node({ id: 'flip-a', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'flip-b', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'ok', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok2', flags: ['master'], address: '10.0.0.3:6379@16379' }),
      node({ id: 'ok3', flags: ['master'], address: '10.0.0.4:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('loopback_flip');
    expect(findings[0].collidingIds).toEqual(['flip-a', 'flip-b']);
  });

  it('does not flag a loopback endpoint whose only ids are dead', () => {
    const nodes = [
      node({ id: 'dead', flags: ['master', 'fail'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'ok', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok2', flags: ['master'], address: '10.0.0.3:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });
});

describe('detectGhostMembers — self-replication corroboration', () => {
  it('flags a replica whose master id is its own id', () => {
    const nodes = [
      node({ id: 'live-a', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-b', flags: ['slave'], master: 'live-b', address: '10.0.0.1:6379@16379' }),
      node({ id: 'other', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].selfReplicatingIds).toEqual(['live-b']);
  });

  it('leaves selfReplicatingIds empty when replication is normal', () => {
    const nodes = [
      node({ id: 'live-a', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-b', flags: ['slave'], master: 'live-a', address: '10.0.0.1:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].selfReplicatingIds).toEqual([]);
  });
});

describe('ghostMemberSignature — reason discrimination', () => {
  it('gives a ghost and a collision on the same endpoint distinct signatures', () => {
    const findings = detectGhostMembers([
      node({ id: 'ghost', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-a', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-b', flags: ['master'], address: '10.0.0.1:6379@16379' }),
    ]);
    const signatures = new Set(
      findings.map((f) => {
        return ghostMemberSignature(f);
      }),
    );
    expect(signatures.size).toBe(findings.length);
  });
});

describe('detectGhostMembers — loopback guard precision', () => {
  it('ignores a DEAD routable record when deciding the cluster is routable', () => {
    // A single fail/noaddr id carrying a routable address must not make an
    // all-loopback local cluster look like a mixed deployment.
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '127.0.0.1:7000@17000' }),
      node({ id: 'b', flags: ['master'], address: '127.0.0.1:7001@17001' }),
      node({ id: 'c', flags: ['master'], address: '127.0.0.1:7002@17002' }),
      node({ id: 'stale', flags: ['master', 'noaddr'], address: '10.0.0.9:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('stays silent when loopback nodes are the MAJORITY and one peer is routable', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '127.0.0.1:7000@17000' }),
      node({ id: 'b', flags: ['master'], address: '127.0.0.1:7001@17001' }),
      node({ id: 'c', flags: ['master'], address: '127.0.0.1:7002@17002' }),
      node({ id: 'lan', flags: ['master'], address: '192.168.1.50:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('stays silent on an even split, where neither side is clearly the anomaly', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '127.0.0.1:7000@17000' }),
      node({ id: 'b', flags: ['master'], address: '10.0.0.2:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('fires once routable peers outnumber the loopback node', () => {
    const nodes = [
      node({ id: 'flipped', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'ok-a', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok-b', flags: ['master'], address: '10.0.0.3:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('loopback_flip');
  });
});

describe('ghostMemberSignature — stability under churn', () => {
  it('is unchanged when the node list is reordered', () => {
    const nodes = [
      node({ id: 'ghost', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-a', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live-b', flags: ['master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'other', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
    ];
    const forward = detectGhostMembers(nodes).map(ghostMemberSignature).sort();
    const reversed = detectGhostMembers([...nodes].reverse())
      .map(ghostMemberSignature)
      .sort();
    expect(forward).toEqual(reversed);
  });

  it('survives a transient handshaking twin on a flipped loopback endpoint', () => {
    const base = [
      node({ id: 'flipped', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'ok-a', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok-b', flags: ['master'], address: '10.0.0.3:6379@16379' }),
    ];
    const before = ghostMemberSignature(detectGhostMembers(base)[0]);

    // A re-MEET adds a handshaking line on the same endpoint for a poll or two.
    const during = ghostMemberSignature(
      detectGhostMembers([
        ...base,
        node({ id: 'rejoining', flags: ['handshake'], address: '127.0.0.1:6379@16379' }),
      ])[0],
    );

    expect(during).toBe(before);
  });
});

describe('detectGhostMembers — loopback census robustness', () => {
  it('keeps firing while a routable peer is temporarily PFAIL', () => {
    // 3-node cluster, one flipped. A peer going fail must not tie the census and
    // silence a CRITICAL that is still true.
    const nodes = [
      node({ id: 'flipped', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'ok-a', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok-b', flags: ['master', 'fail?'], address: '10.0.0.3:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings.map((f) => f.reason)).toContain('loopback_flip');
  });

  it('counts a shared loopback endpoint once, so a collision stays CRITICAL', () => {
    // Two ids on one loopback address is still ONE bad endpoint. Counting them
    // as two would tip the census and demote this to a plain collision.
    const nodes = [
      node({ id: 'flip-a', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'flip-b', flags: ['master'], address: '127.0.0.1:6379@16379' }),
      node({ id: 'ok-a', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379' }),
      node({ id: 'ok-b', flags: ['master'], address: '10.0.0.3:6379@16379' }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('loopback_flip');
  });

  it('still needs a live routable peer, not just a dead record', () => {
    const nodes = [
      node({ id: 'a', flags: ['myself', 'master'], address: '127.0.0.1:7000@17000' }),
      node({ id: 'b', flags: ['master'], address: '127.0.0.1:7001@17001' }),
      node({ id: 'stale', flags: ['master', 'noaddr'], address: '10.0.0.9:6379@16379' }),
      node({ id: 'stale2', flags: ['master', 'fail'], address: '10.0.0.8:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });
});
