import { ClusterNode } from '@app/common/types/metrics.types';
import {
  canonicalEndpoint,
  detectGhostMembers,
  ghostMemberSignature,
} from '../ghost-membership-detector';

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
      node({ id: 'a', flags: ['myself', 'master'], address: '10.0.0.1:6379@16379', slots: [[0, 8191]] }),
      node({ id: 'b', flags: ['master'], address: '10.0.0.2:6379@16379', slots: [[8192, 16383]] }),
      node({ id: 'r', flags: ['slave'], master: 'b', address: '10.0.0.3:6379@16379' }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('returns nothing for a node that failed and recovered under its SAME id', () => {
    // Same endpoint, same id — a single-id endpoint, not a ghost.
    const nodes = [
      node({ id: 'a', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379', slots: [[0, 16383]] }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('detects a HARD-reset ghost: old id lingers as fail, new id occupies the endpoint', () => {
    const nodes = [
      node({ id: 'old-ghost-id', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379', slots: [[0, 5460]], configEpoch: 5 }),
      node({ id: 'new-live-id', flags: ['master'], address: '10.0.0.1:6379@16379', configEpoch: 0 }),
      node({ id: 'other', flags: ['myself', 'master'], address: '10.0.0.2:6379@16379', slots: [[5461, 16383]] }),
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
      node({ id: 'established', flags: ['master'], address: '10.0.0.1:6379@16379', linkState: 'connected' }),
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
      node({ id: 'old-prim', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379', slots: [[0, 16383]] }),
      node({ id: 'promoted', flags: ['master'], address: '10.0.0.2:6379@16379', slots: [[0, 16383]] }),
    ];
    expect(detectGhostMembers(nodes)).toEqual([]);
  });

  it('aggregates multiple ghosts on one endpoint into a single finding', () => {
    const nodes = [
      node({ id: 'ghost-a', flags: ['master', 'fail'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'ghost-b', flags: ['noaddr', 'master'], address: '10.0.0.1:6379@16379' }),
      node({ id: 'live', flags: ['myself', 'master'], address: '10.0.0.1:6379@16379', slots: [[0, 16383]] }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0].ghostIds).toEqual(['ghost-a', 'ghost-b']); // sorted
    expect(findings[0].liveId).toBe('live');
  });

  it('detects a ghost on a compressed IPv6 endpoint', () => {
    const nodes = [
      node({ id: 'ghost', flags: ['master', 'fail'], address: '::1:6379@16379' }),
      node({ id: 'live', flags: ['myself', 'master'], address: '::1:6379@16379', slots: [[0, 16383]] }),
    ];
    const findings = detectGhostMembers(nodes);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ endpoint: '::1:6379', ghostIds: ['ghost'], liveId: 'live' });
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
