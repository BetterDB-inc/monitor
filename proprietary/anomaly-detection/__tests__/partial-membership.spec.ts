import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  PARTIAL_MEMBERSHIP_MIN_AGE_MS,
  type PartialMembership,
  membershipSides,
  membershipSightings,
  partialMembershipMessage,
  partialMembershipNodeId,
  partialMembershipSignature,
  partiallyKnownNodes,
  renamedPartialMemberships,
  unclaimedByPartialMembership,
} from '../partial-membership';
import {
  DivergenceTracker,
  type TopologyView,
  type TrackedDisagreement,
  compareTopologyViews,
  membersByObserver,
} from '../topology-divergence';

type NodePatch = Partial<ClusterNode> | null;

interface Round {
  at: number;
  views: TopologyView[];
  unanswered?: string[];
}

const ROUND_MS = 5_000;
const MIN_ROUNDS = 3;

const NEW_NODE = primary('n1', 7, [], 0);

const NEW_REPLICA: ClusterNode = { ...primary('r1', 8, [], 0), flags: ['slave'], master: 'n1' };

const BASE: ClusterNode[] = [
  primary('p1', 1, [[0, 5460]], 1),
  primary('p2', 2, [[5461, 10922]], 2),
  primary('p3', 3, [[10923, 16383]], 3),
  NEW_NODE,
];

function primary(id: string, host: number, slots: number[][], configEpoch: number): ClusterNode {
  return {
    id,
    address: `10.0.0.${host}:6379@16379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch,
    linkState: 'connected',
    slots,
  };
}

function view(observerId: string, patches: Record<string, NodePatch> = {}, extra: ClusterNode[] = []): TopologyView {
  const nodes = BASE.flatMap((node) => {
    const patch = patches[node.id];
    if (patch === null) return [];
    const patched = { ...node, ...patch };
    return [node.id === observerId ? { ...patched, flags: ['myself', ...patched.flags] } : patched];
  });
  return { observerId, nodes: [...nodes, ...extra] };
}

function handshakeWith(node: ClusterNode, temporaryId = `tmp-${node.id}`): ClusterNode {
  return { ...node, id: temporaryId, flags: ['handshake'], slots: [], linkState: 'disconnected' };
}

function withoutAddress(node: ClusterNode): Partial<ClusterNode> {
  return { address: ':0@0', flags: [...node.flags, 'noaddr'], linkState: 'disconnected' };
}

function every(views: TopologyView[], from: number, until: number, unanswered: string[] = []): Round[] {
  const rounds: Round[] = [];
  for (let at = from; at <= until; at += ROUND_MS) rounds.push({ at, views, unanswered });
  return rounds;
}

function judge(
  rounds: Round[],
  openNodeIds: string[] = [],
): { found: PartialMembership[]; tracked: TrackedDisagreement[] } {
  const tracker = new DivergenceTracker();
  for (const round of rounds) {
    tracker.observe({
      at: round.at,
      disagreements: compareTopologyViews(round.views),
      unanswered: round.unanswered ?? [],
      views: round.views.length,
      members: membersByObserver(round.views),
    });
  }
  const last = rounds[rounds.length - 1];
  const tracked = tracker.tracked();
  const nodes = new Map<string, ClusterNode>();
  const selves = new Map<string, ClusterNode>();
  for (const seen of last.views) {
    for (const node of seen.nodes) {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      if (node.id === seen.observerId) selves.set(node.id, node);
    }
  }
  const found = partiallyKnownNodes({
    disagreements: tracked,
    sightings: membershipSightings(last.views, tracked),
    nodes,
    selves,
    at: last.at,
    minRounds: MIN_ROUNDS,
    openNodeIds: new Set(openNodeIds),
  });
  return { found, tracked };
}

function unclaimedKeys(
  tracked: TrackedDisagreement[],
  found: PartialMembership[],
  kind: TrackedDisagreement['kind'],
): string[] {
  return unclaimedByPartialMembership(tracked, found)
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.key);
}

function unclaimedMemberships(tracked: TrackedDisagreement[], found: PartialMembership[]): string[] {
  return unclaimedKeys(tracked, found, 'membership');
}

function unclaimedSlotDisputes(tracked: TrackedDisagreement[], found: PartialMembership[]): string[] {
  return unclaimedKeys(tracked, found, 'slot_owner');
}

function ids(peers: Array<{ nodeId: string }>): string[] {
  return peers.map((peer) => peer.nodeId);
}

const KNOWN_BY_P1_ONLY = [view('p1'), view('p2', { n1: null }), view('p3', { n1: null })];
const LONG_ENOUGH = PARTIAL_MEMBERSHIP_MIN_AGE_MS + ROUND_MS;

describe('partiallyKnownNodes', () => {
  it('finds nothing when every view lists the same nodes', () => {
    const { found } = judge(every([view('p1'), view('p2'), view('p3')], 0, LONG_ENOUGH));
    expect(found).toEqual([]);
  });

  it('names the peers that know a node and the peers that do not', () => {
    const { found } = judge(every(KNOWN_BY_P1_ONLY, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      signature: 'partial_membership:n1',
      nodeId: 'n1',
      address: '10.0.0.7:6379',
      confirmed: true,
      firstSeenAt: 0,
      disagreementKeys: ['membership:n1'],
    });
    expect(ids(found[0].knownBy)).toEqual(['p1']);
    expect(found[0].notKnownBy).toEqual([
      { nodeId: 'p2', address: '10.0.0.2:6379', status: 'missing' },
      { nodeId: 'p3', address: '10.0.0.3:6379', status: 'missing' },
    ]);
    expect(found[0].ownViewMissing).toEqual([]);
  });

  it('gives a command that can be run and the nodes to run it on', () => {
    const { found } = judge(every(KNOWN_BY_P1_ONLY, 0, LONG_ENOUGH));

    expect(found[0].meet).toEqual({
      ip: '10.0.0.7',
      port: 6379,
      busPort: 16379,
      command: 'CLUSTER MEET 10.0.0.7 6379',
      runOn: [
        { nodeId: 'p2', address: '10.0.0.2:6379' },
        { nodeId: 'p3', address: '10.0.0.3:6379' },
      ],
    });
  });

  it('reports a peer that keeps the node in handshake', () => {
    const views = [view('p1'), view('p2', { n1: null }, [handshakeWith(NEW_NODE)]), view('p3')];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(ids(found[0].knownBy)).toEqual(['p1', 'p3']);
    expect(found[0].notKnownBy).toEqual([{ nodeId: 'p2', address: '10.0.0.2:6379', status: 'handshake' }]);
  });

  it('reports a peer that holds the node without an address', () => {
    const views = [view('p1'), view('p2'), view('p3', { n1: withoutAddress(NEW_NODE) })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0].address).toBe('10.0.0.7:6379');
    expect(found[0].notKnownBy).toEqual([{ nodeId: 'p3', address: '10.0.0.3:6379', status: 'noaddr' }]);
    expect(found[0].meet?.command).toBe('CLUSTER MEET 10.0.0.7 6379');
  });

  it('keeps the same finding while a peer moves between handshake and missing', () => {
    const inHandshake = [view('p1'), view('p2', { n1: null }, [handshakeWith(NEW_NODE)]), view('p3')];
    const missing = [view('p1'), view('p2', { n1: null }), view('p3')];
    const rounds = every(inHandshake, 0, LONG_ENOUGH).map((round, i) => (i % 2 ? { ...round, views: missing } : round));
    const { found } = judge(rounds);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: true, firstSeenAt: 0 });
  });

  it('does not confirm a node before it was half known for the minimum age', () => {
    const early = judge(every(KNOWN_BY_P1_ONLY, 0, PARTIAL_MEMBERSHIP_MIN_AGE_MS - ROUND_MS));
    expect(early.found).toHaveLength(1);
    expect(early.found[0].confirmed).toBe(false);

    const due = judge(every(KNOWN_BY_P1_ONLY, 0, PARTIAL_MEMBERSHIP_MIN_AGE_MS));
    expect(due.found[0].confirmed).toBe(true);
  });

  it('does not confirm a node seen half known in too few rounds', () => {
    const { found } = judge([
      { at: 0, views: KNOWN_BY_P1_ONLY },
      { at: LONG_ENOUGH, views: KNOWN_BY_P1_ONLY },
    ]);
    expect(found[0]).toMatchObject({ rounds: 2, confirmed: false });
  });

  it('finds nothing after a normal add once every view lists the node', () => {
    const joining = every(KNOWN_BY_P1_ONLY, 0, 2 * ROUND_MS);
    const joined = every([view('p1'), view('p2'), view('p3')], 3 * ROUND_MS, LONG_ENOUGH);

    expect(judge(joining).found.every((finding) => !finding.confirmed)).toBe(true);
    expect(judge([...joining, ...joined]).found).toEqual([]);
  });

  it('never confirms a node that was forgotten and comes back when the ban ends', () => {
    const forgotten = [view('p1', { n1: null }), view('p2'), view('p3')];
    const banMs = 60_000;
    const rounds = [
      ...every(forgotten, 0, banMs),
      ...every([view('p1'), view('p2'), view('p3')], banMs + ROUND_MS, LONG_ENOUGH),
    ];

    for (let seen = 1; seen <= rounds.length; seen++) {
      expect(judge(rounds.slice(0, seen)).found.filter((finding) => finding.confirmed)).toEqual([]);
    }
  });

  it('starts the age over when the node is half known again', () => {
    const rounds = [
      ...every(KNOWN_BY_P1_ONLY, 0, 2 * ROUND_MS),
      ...every([view('p1'), view('p2'), view('p3')], 3 * ROUND_MS, 4 * ROUND_MS),
      ...every(KNOWN_BY_P1_ONLY, 5 * ROUND_MS, LONG_ENOUGH),
    ];
    const { found } = judge(rounds);
    expect(found[0]).toMatchObject({ firstSeenAt: 5 * ROUND_MS, confirmed: false });
  });

  it('never lists a peer whose view could not be read', () => {
    const views = [view('p1'), view('p2', { n1: null })];
    const { found } = judge(every(views, 0, LONG_ENOUGH, ['p3']));

    expect(ids(found[0].knownBy)).toEqual(['p1']);
    expect(ids(found[0].notKnownBy)).toEqual(['p2']);
  });

  it('holds the count while the only peer that lacks the node gives no view', () => {
    const seen = every([view('p1'), view('p2', { n1: null }), view('p3')], 0, ROUND_MS);
    const unread = every([view('p1'), view('p3')], 2 * ROUND_MS, LONG_ENOUGH, ['p2']);
    const { found } = judge([...seen, ...unread]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'n1', rounds: 2, confirmed: false });
    expect(found[0].notKnownBy).toEqual([]);
  });

  it('gives no command while no node that showed the gap gives a view', () => {
    const seen = every([view('p1'), view('p2', { n1: null }), view('p3')], 0, ROUND_MS);
    const unread = every([view('p1'), view('p3')], 2 * ROUND_MS, LONG_ENOUGH, ['p2']);
    const { found } = judge([...seen, ...unread]);

    expect(found[0].meet).toBeUndefined();
    expect(partialMembershipMessage(found[0], LONG_ENOUGH)).toBe(
      'Node 10.0.0.7:6379 has only partly joined the cluster for 95s. ' +
        'Known by 10.0.0.1:6379, 10.0.0.3:6379. ' +
        'No node that showed the gap gave a view this round, so no CLUSTER MEET command can be given.',
    );
  });

  describe('when a dispute is held with the positions of an earlier round', () => {
    const at = LONG_ENOUGH + ROUND_MS;

    it('leaves out the peers that have learned the node since', () => {
      const stuck = every([view('p1'), view('p2', { n1: null }), view('p3', { n1: null })], 0, LONG_ENOUGH);
      const { found, tracked } = judge([...stuck, { at, views: [view('p2'), view('p3')], unanswered: ['p1'] }]);

      expect(tracked).toMatchObject([{ key: 'membership:n1', lastSeenAt: LONG_ENOUGH }]);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: false });
      expect(found[0].notKnownBy).toEqual([]);
      expect(found[0].meet).toBeUndefined();
    });

    it('keeps the peers that answer and still lack the node', () => {
      const lacking = [view('p2', { n1: null }), view('p3', { n1: null })];
      const stuck = every([view('p1'), ...lacking], 0, LONG_ENOUGH);
      const { found } = judge([...stuck, { at, views: lacking, unanswered: ['p1'] }], ['n1']);

      expect(ids(found[0].notKnownBy)).toEqual(['p2', 'p3']);
    });

    it('leaves out the peers that no longer list the node', () => {
      const stuck = every([view('p1'), view('p2', { n1: null }), view('p3')], 0, LONG_ENOUGH);
      const forgotten = [view('p1', { n1: null }), view('p3', { n1: null })];
      const { found } = judge([...stuck, { at, views: forgotten, unanswered: ['p2'] }], ['n1']);

      expect(found).toHaveLength(1);
      expect(found[0].knownBy).toEqual([]);
      expect(found[0].notKnownBy).toEqual([]);
    });
  });

  describe('when a held link is gone and another link confirms the node', () => {
    const lacksP3 = 4 * ROUND_MS;
    const confirmedAt = lacksP3 + LONG_ENOUGH;
    const heldAt = confirmedAt + ROUND_MS;
    const at = heldAt + ROUND_MS;
    const rounds: Round[] = [
      ...every([view('p1'), view('p2', { n1: null }), view('n1'), view('p3')], 0, lacksP3 - ROUND_MS),
      ...every([view('p1'), view('p2', { n1: null }), view('n1', { p3: null }), view('p3')], lacksP3, confirmedAt),
      { at: heldAt, views: [view('p1'), view('p2', { n1: null })], unanswered: ['n1', 'p3'] },
      { at, views: [view('p2'), view('n1', { p3: null }), view('p3')], unanswered: ['p1'] },
    ];

    it('holds the old disagreement and sees the other one', () => {
      const { tracked } = judge(rounds);
      const memberships = tracked.filter((entry) => entry.kind === 'membership');

      expect(memberships).toMatchObject([
        { key: 'membership:n1', lastSeenAt: heldAt, positions: [{ observers: ['p1'] }, { observers: ['p2'] }] },
        { key: 'membership:p3', lastSeenAt: at },
      ]);
    });

    it('names the peers that list the node in that round and gives the command only where it is needed', () => {
      const [finding, ...others] = judge(rounds).found;

      expect(others).toEqual([]);
      expect(finding).toMatchObject({ nodeId: 'n1', confirmed: true });
      expect(ids(finding.knownBy)).toEqual(['p2', 'p3']);
      expect(finding.notKnownBy).toEqual([]);
      expect(ids(finding.ownViewMissing)).toEqual(['p3']);
      expect(ids(finding.meet?.runOn ?? [])).toEqual(['p3']);

      const message = partialMembershipMessage(finding, at);
      expect(message).toContain('Known by 10.0.0.2:6379, 10.0.0.3:6379.');
      expect(message).not.toContain('Not known by');
      expect(message).toContain('Its own view is missing 10.0.0.3:6379.');
      expect(message).toContain('Run `CLUSTER MEET 10.0.0.7 6379` on 10.0.0.3:6379.');
    });

    it('takes its age from the link that is still there', () => {
      const [finding] = judge(rounds).found;

      expect(finding.firstSeenAt).toBe(lacksP3);
      expect(partialMembershipMessage(finding, at)).toContain(`for ${(at - lacksP3) / 1000}s.`);
    });

    it('keeps that age when the peer of the gone link then gives no view', () => {
      const silent = { at: at + ROUND_MS, views: [view('n1', { p3: null }), view('p3')], unanswered: ['p1', 'p2'] };
      const { found, tracked } = judge([...rounds, silent]);

      expect(tracked).toMatchObject([{ key: 'membership:n1', lastSeenAt: heldAt }, { key: 'membership:p3' }, {}]);
      expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: true, firstSeenAt: lacksP3 });
      expect(found[0].notKnownBy).toEqual([]);
    });
  });

  describe('when a dispute is held because one side gave no view', () => {
    const p2 = BASE[1];
    const p3 = BASE[2];
    const ownView = view('n1', { p2: null, p3: null }, [handshakeWith(p2), handshakeWith(p3)]);
    const stuck = every([view('p1'), view('p2', { n1: null }), view('p3', { n1: null }), ownView], 0, LONG_ENOUGH);
    const at = LONG_ENOUGH + ROUND_MS;

    it('leaves out what the unread view of the node itself was missing', () => {
      const views = [view('p1'), view('p2', { n1: null })];
      const { found } = judge([...stuck, { at, views, unanswered: ['p3', 'n1'] }]);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: true });
      expect(ids(found[0].knownBy)).toEqual(['p1']);
      expect(ids(found[0].notKnownBy)).toEqual(['p2']);
      expect(found[0].ownViewMissing).toEqual([]);
      expect(ids(found[0].meet?.runOn ?? [])).toEqual(['p2']);
      expect(found[0].disagreementKeys).toEqual(['membership:n1', 'membership:p2', 'membership:p3']);
      expect(partialMembershipMessage(found[0], at)).not.toContain('Its own view is missing');
    });

    it('leaves out the unread peers that lacked the node', () => {
      const { found } = judge([...stuck, { at, views: [view('p1'), ownView], unanswered: ['p2', 'p3'] }]);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: true });
      expect(ids(found[0].knownBy)).toEqual(['p1']);
      expect(found[0].notKnownBy).toEqual([]);
      expect(ids(found[0].ownViewMissing)).toEqual(['p2', 'p3']);
      expect(partialMembershipMessage(found[0], at)).not.toContain('Not known by');
    });
  });

  it('makes one finding of a join that is broken in both directions', () => {
    const p2 = BASE[1];
    const p3 = BASE[2];
    const views = [
      view('p1'),
      view('p2', { n1: null }),
      view('p3', { n1: null }),
      view('n1', { p2: null, p3: null }, [handshakeWith(p2), handshakeWith(p3)]),
    ];
    const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

    expect(tracked.filter((entry) => entry.kind === 'membership').map((entry) => entry.key)).toEqual([
      'membership:n1',
      'membership:p2',
      'membership:p3',
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('n1');
    expect(ids(found[0].knownBy)).toEqual(['p1']);
    expect(ids(found[0].notKnownBy)).toEqual(['p2', 'p3']);
    expect(found[0].ownViewMissing).toEqual([
      { nodeId: 'p2', address: '10.0.0.2:6379', status: 'handshake' },
      { nodeId: 'p3', address: '10.0.0.3:6379', status: 'handshake' },
    ]);
    expect(found[0].disagreementKeys).toEqual(['membership:n1', 'membership:p2', 'membership:p3']);
    expect(ids(found[0].meet?.runOn ?? [])).toEqual(['p2', 'p3']);
    expect(unclaimedMemberships(tracked, found)).toEqual([]);
  });

  it('files a node every peer knows under itself when only its own view lacks a peer', () => {
    const views = [view('p1'), view('p2'), view('p3'), view('n1', { p2: null })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'n1', address: '10.0.0.7:6379', confirmed: true });
    expect(ids(found[0].knownBy)).toEqual(['p1', 'p2', 'p3']);
    expect(found[0].notKnownBy).toEqual([]);
    expect(found[0].ownViewMissing).toEqual([{ nodeId: 'p2', address: '10.0.0.2:6379', status: 'missing' }]);
    expect(found[0].meet).toMatchObject({
      command: 'CLUSTER MEET 10.0.0.7 6379',
      runOn: [{ nodeId: 'p2', address: '10.0.0.2:6379' }],
    });
  });

  it('files a broken link between two slot owners under the one that is not known', () => {
    const views = [view('p1'), view('p2', { p3: null }), view('p3')];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('p3');
    expect(ids(found[0].notKnownBy)).toEqual(['p2']);
    expect(found[0].ownViewMissing).toEqual([]);
    expect(found[0].meet?.command).toBe('CLUSTER MEET 10.0.0.3 6379');
    expect(ids(found[0].meet?.runOn ?? [])).toEqual(['p2']);
  });

  it('files two slot owners that do not know each other under the smaller id', () => {
    const views = [view('p1'), view('p2', { p3: null }), view('p3', { p2: null })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('p2');
    expect(ids(found[0].notKnownBy)).toEqual(['p3']);
    expect(ids(found[0].ownViewMissing)).toEqual(['p3']);
  });

  it('keeps two slot owners that do not know each other under the one with an open event', () => {
    const views = [view('p1'), view('p2', { p3: null }), view('p3', { p2: null })];
    const { found } = judge(every(views, 0, LONG_ENOUGH), ['p3']);

    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('p3');
    expect(found[0].meet?.command).toBe('CLUSTER MEET 10.0.0.3 6379');
  });

  it('names a new primary and its replica, not the slot owner that has not learned them', () => {
    const views = [view('p1', {}, [NEW_REPLICA]), view('p2', { n1: null }), view('p3', {}, [NEW_REPLICA])];
    const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

    expect(found.map((finding) => finding.nodeId)).toEqual(['n1', 'r1']);
    for (const finding of found) {
      expect(finding.confirmed).toBe(true);
      expect(ids(finding.knownBy)).toEqual(['p1', 'p3']);
      expect(ids(finding.notKnownBy)).toEqual(['p2']);
      expect(finding.ownViewMissing).toEqual([]);
      expect(ids(finding.meet?.runOn ?? [])).toEqual(['p2']);
    }
    expect(found[1].meet?.command).toBe('CLUSTER MEET 10.0.0.8 6379');
    expect(unclaimedMemberships(tracked, found)).toEqual([]);
  });

  it('does not name that slot owner because it has an open event either', () => {
    const views = [view('p1', {}, [NEW_REPLICA]), view('p2', { n1: null }), view('p3', {}, [NEW_REPLICA])];
    const { found } = judge(every(views, 0, LONG_ENOUGH), ['p2']);
    expect(found.map((finding) => finding.nodeId)).toEqual(['n1', 'r1']);
  });

  it('names two new nodes a slot owner lacks apart from that slot owner, which a peer lacks', () => {
    const other = primary('n2', 8, [], 0);
    const views = [
      view('p1', {}, [other]),
      view('p2', { p3: null }, [other]),
      view('p3', { n1: null }),
    ];
    const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

    expect(found.map((finding) => finding.nodeId)).toEqual(['n1', 'n2', 'p3']);
    expect(found.map((finding) => finding.disagreementKeys)).toEqual([
      ['membership:n1'],
      ['membership:n2'],
      ['membership:p3'],
    ]);
    expect(ids(found[0].notKnownBy)).toEqual(['p3']);
    expect(ids(found[1].notKnownBy)).toEqual(['p3']);
    expect(ids(found[2].notKnownBy)).toEqual(['p2']);
    expect(found[2].ownViewMissing).toEqual([]);
    expect(unclaimedMemberships(tracked, found)).toEqual([]);
  });

  it('names a new replica a slot owner lacks apart from that slot owner, which a peer lacks', () => {
    const views = [view('p1', {}, [NEW_REPLICA]), view('p2'), view('p3', { p2: null }, [NEW_REPLICA])];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found.map((finding) => finding.nodeId)).toEqual(['p2', 'r1']);
    expect(ids(found[0].notKnownBy)).toEqual(['p3']);
    expect(found[0].ownViewMissing).toEqual([]);
    expect(found[0].disagreementKeys).toEqual(['membership:p2']);
    expect(ids(found[1].notKnownBy)).toEqual(['p2']);
    expect(found[1].disagreementKeys).toEqual(['membership:r1']);
  });

  describe('when two new nodes do not know each other', () => {
    const other = primary('n2', 8, [], 0);
    const strangers = [
      view('p1', {}, [other]),
      view('p2', {}, [other]),
      view('n1'),
      { observerId: 'n2', nodes: [...BASE.slice(0, 3), { ...other, flags: ['myself', 'master'] }] },
    ];

    it('names the smaller id', () => {
      const { found } = judge(every(strangers, 0, LONG_ENOUGH));

      expect(found.map((finding) => finding.nodeId)).toEqual(['n1']);
      expect(ids(found[0].notKnownBy)).toEqual(['n2']);
      expect(ids(found[0].ownViewMissing)).toEqual(['n2']);
    });

    it('names the same nodes after the views that showed part of the gap stop coming', () => {
      const [p1, p2, , second] = strangers;
      const all = every([...strangers, view('p3', {}, [])], 0, ROUND_MS);
      const silent = every([p1, p2, second], 2 * ROUND_MS, LONG_ENOUGH, ['n1', 'p3']);
      const before = judge(all).found;
      const after = judge([...all, ...silent]).found;

      expect(before.map((finding) => finding.nodeId)).toEqual(['n1', 'n2']);
      expect(after.map((finding) => finding.nodeId)).toEqual(['n1', 'n2']);
      expect(after[0].disagreementKeys).toEqual(['membership:n1', 'membership:n2']);
      expect(ids(after[0].notKnownBy)).toEqual(['n2']);
      expect(after[1]).toMatchObject({ notKnownBy: [], ownViewMissing: [], disagreementKeys: ['membership:n2'] });
      expect(after[1].meet).toBeUndefined();
    });
  });

  it('counts a peer from the round it stopped listing the node, not from when another peer lacked it', () => {
    const before = every([view('p1'), view('p2', { n1: null }), view('p3')], 0, LONG_ENOUGH);
    const at = LONG_ENOUGH + ROUND_MS;
    const swapped = [view('p1'), view('p2'), view('p3', { n1: null })];
    const { found } = judge([...before, { at, views: swapped }]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: false, firstSeenAt: at, rounds: 1 });
    expect(ids(found[0].notKnownBy)).toEqual(['p3']);

    const later = at + PARTIAL_MEMBERSHIP_MIN_AGE_MS;
    const { found: confirmed } = judge([...before, ...every(swapped, at, later)]);
    expect(confirmed[0]).toMatchObject({ nodeId: 'n1', confirmed: true, firstSeenAt: at });
  });

  it('starts a peer at zero when it listed the node while the disagreement was held and then loses it', () => {
    const stuck = every(KNOWN_BY_P1_ONLY, 0, LONG_ENOUGH);
    const learned = every([view('p2'), view('p3')], LONG_ENOUGH + ROUND_MS, LONG_ENOUGH + 2 * ROUND_MS, ['p1']);
    const at = LONG_ENOUGH + 3 * ROUND_MS;
    const forgot = { at, views: [view('p1'), view('p2', { n1: null }), view('p3')] };
    const { found } = judge([...stuck, ...learned, forgot]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: false, firstSeenAt: at, rounds: 1 });
    expect(ids(found[0].notKnownBy)).toEqual(['p2']);
  });

  it('does not count the time another node lacked the same peer', () => {
    const other = primary('n2', 8, [], 0);
    const stuck = [view('p1'), view('p2'), view('p3'), view('n1', { p2: null })];
    const joining = {
      observerId: 'n2',
      nodes: [BASE[0], BASE[2], NEW_NODE, { ...other, flags: ['myself', 'master'] }],
    };
    const at = LONG_ENOUGH + ROUND_MS;
    const all = [...['p1', 'p2', 'p3'].map((id) => view(id, {}, [other])), view('n1', { p2: null }, [other]), joining];
    const { found } = judge([...every(stuck, 0, LONG_ENOUGH), { at, views: all }]);

    expect(found.map((finding) => finding.nodeId)).toEqual(['n1', 'n2']);
    expect(found[0]).toMatchObject({ confirmed: true, firstSeenAt: 0 });
    expect(found[1]).toMatchObject({ confirmed: false, firstSeenAt: at, rounds: 1 });
    expect(ids(found[1].ownViewMissing)).toEqual(['p2']);
  });

  it('keeps the time a node lacked a peer through rounds it gave no view', () => {
    const other = primary('n2', 8, [], 0);
    const peers = ['p1', 'p2', 'p3'].map((id) => view(id, {}, [other]));
    const blind = (id: string, self: ClusterNode): TopologyView => ({
      observerId: id,
      nodes: [BASE[0], BASE[2], ...[NEW_NODE, other].map((node) => (node.id === id ? self : node))],
    });
    const first = blind('n1', { ...NEW_NODE, flags: ['myself', 'master'] });
    const second = blind('n2', { ...other, flags: ['myself', 'master'] });
    const both = every([...peers, first, second], 0, LONG_ENOUGH - 2 * ROUND_MS);
    const oneSilent = { at: LONG_ENOUGH - ROUND_MS, views: [...peers, second], unanswered: ['n1'] };
    const { found } = judge([...both, oneSilent, { at: LONG_ENOUGH, views: [...peers, first, second] }]);

    expect(found.map((finding) => finding.nodeId)).toEqual(['n1', 'n2']);
    expect(found[0]).toMatchObject({ confirmed: true, firstSeenAt: 0 });
  });

  it('names a new replica one slot owner has not learned, not the slot owner', () => {
    const views = [view('p1', {}, [NEW_REPLICA]), view('p2'), view('p3', {}, [NEW_REPLICA])];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'r1', address: '10.0.0.8:6379' });
    expect(ids(found[0].notKnownBy)).toEqual(['p2']);
  });

  it('names a replica whose own view lacks a slot owner, not the slot owner', () => {
    const blind: TopologyView = {
      observerId: 'r1',
      nodes: [BASE[0], BASE[2], NEW_NODE, { ...NEW_REPLICA, flags: ['myself', 'slave'] }],
    };
    const everyone = ['p1', 'p2', 'p3'].map((id) => view(id, {}, [NEW_REPLICA]));
    const { found } = judge(every([...everyone, blind], 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('r1');
    expect(ids(found[0].knownBy)).toEqual(['p1', 'p2', 'p3']);
    expect(ids(found[0].ownViewMissing)).toEqual(['p2']);
    expect(found[0].meet).toMatchObject({ command: 'CLUSTER MEET 10.0.0.8 6379' });
    expect(ids(found[0].meet?.runOn ?? [])).toEqual(['p2']);
  });

  describe('when its own view shows the slots of an owner it lacks as unassigned', () => {
    const SLOTS_OF_P2 = 'slot_owner:p2|unassigned';
    const SLOTS_OF_P3 = 'slot_owner:p3|unassigned';
    const everyone = [view('p1'), view('p2'), view('p3')];
    const lacksP2 = [...everyone, view('n1', { p2: null })];

    it('holds the slot dispute from the first round', () => {
      const { found, tracked } = judge(every(lacksP2, 0, 0));

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        nodeId: 'n1',
        confirmed: false,
        disagreementKeys: ['membership:p2'],
        slotDisputeKeys: [SLOTS_OF_P2],
      });
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([]);
    });

    it('holds one slot dispute for each slot owner it lacks', () => {
      const { found, tracked } = judge(every([...everyone, view('n1', { p2: null, p3: null })], 0, LONG_ENOUGH));

      expect(found).toHaveLength(1);
      expect(found[0].slotDisputeKeys).toEqual([SLOTS_OF_P2, SLOTS_OF_P3]);
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([]);
    });

    it('holds a slot dispute a new primary and its replica both explain', () => {
      const views = [
        ...['p1', 'p2', 'p3'].map((id) => view(id, {}, [NEW_REPLICA])),
        view('n1', { p2: null }, [NEW_REPLICA]),
        view('r1', { p2: null }, [{ ...NEW_REPLICA, flags: ['myself', 'slave'] }]),
      ];
      const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

      expect(found.map((finding) => finding.nodeId)).toEqual(['n1', 'r1']);
      expect(found.map((finding) => finding.slotDisputeKeys)).toEqual([[SLOTS_OF_P2], [SLOTS_OF_P2]]);
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([]);
    });

    it('keeps holding the slot dispute while the node gives no view', () => {
      const rounds = [...every(lacksP2, 0, 2 * ROUND_MS), { at: 3 * ROUND_MS, views: everyone, unanswered: ['n1'] }];
      const { found, tracked } = judge(rounds);

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nodeId: 'n1', ownViewMissing: [], slotDisputeKeys: [SLOTS_OF_P2] });
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([]);
    });

    it('leaves the slot dispute when it names another owner for the slots', () => {
      const ownView = view('n1', { p2: null, p3: { slots: [[5461, 16383]] } });
      const { found, tracked } = judge(every([...everyone, ownView], 0, LONG_ENOUGH));

      expect(found).toHaveLength(1);
      expect(found[0].slotDisputeKeys).toEqual([]);
      expect(unclaimedSlotDisputes(tracked, found)).toEqual(['slot_owner:p2|p3']);
    });

    it('leaves the slot dispute when a peer that knows the owner sees the slots unassigned too', () => {
      const views = [view('p1'), view('p2'), view('p3', { p2: { slots: [] } }), view('n1', { p2: null })];
      const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

      expect(found).toHaveLength(1);
      expect(found[0].slotDisputeKeys).toEqual([]);
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([SLOTS_OF_P2]);
    });

    it('leaves the slot dispute when a third view gives the slots to another owner', () => {
      const views = [view('p1'), view('p2'), view('p3', { p3: { slots: [[5461, 16383]] } }), view('n1', { p2: null })];
      const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

      expect(found).toHaveLength(1);
      expect(found[0].slotDisputeKeys).toEqual([]);
      expect(unclaimedSlotDisputes(tracked, found)).toEqual(['slot_owner:p2|p3|unassigned']);
    });

    it('leaves a slot dispute over an owner it knows', () => {
      const ownView = view('n1', { p2: null, p3: { slots: [] } });
      const { found, tracked } = judge(every([...everyone, ownView], 0, LONG_ENOUGH));

      expect(found[0].slotDisputeKeys).toEqual([SLOTS_OF_P2]);
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([SLOTS_OF_P3]);
    });

    it('leaves a slot dispute voted by a peer that only lacks the new node', () => {
      const views = [view('p1'), view('p2', { n1: null }), view('p3', { n1: null, p2: { slots: [] } })];
      const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nodeId: 'n1', slotDisputeKeys: [] });
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([SLOTS_OF_P2]);
    });

    it('leaves the slot disputes of two slot owners that do not know each other', () => {
      const views = [view('p1'), view('p2', { p3: null }), view('p3', { p2: null })];
      const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nodeId: 'p2', slotDisputeKeys: [] });
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([SLOTS_OF_P2, SLOTS_OF_P3]);
    });

    it('lets go of a slot dispute that is still there once it has learned the owner', () => {
      const learned = [...everyone, view('n1', { p2: { slots: [] } })];
      const rounds = [...every(lacksP2, 0, 2 * ROUND_MS), { at: 3 * ROUND_MS, views: learned }];
      const { found, tracked } = judge(rounds);

      expect(found).toEqual([]);
      expect(unclaimedSlotDisputes(tracked, found)).toEqual([SLOTS_OF_P2]);
      expect(tracked.find((entry) => entry.key === SLOTS_OF_P2)).toMatchObject({ rounds: 4, lastSeenAt: 3 * ROUND_MS });
    });
  });

  it('reads a handshake line on an address two node ids share as missing, not as handshake', () => {
    const staleTwin: ClusterNode = { ...NEW_NODE, id: 'n0', flags: ['master', 'fail'], linkState: 'disconnected' };
    const views = [
      view('p1', {}, [staleTwin]),
      view('p2', { n1: null }, [handshakeWith(NEW_NODE)]),
      view('p3', {}, [staleTwin]),
    ];
    const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0].nodeId).toBe('n1');
    expect(found[0].notKnownBy).toEqual([{ nodeId: 'p2', address: '10.0.0.2:6379', status: 'missing' }]);
    expect(unclaimedMemberships(tracked, found)).toEqual(['membership:n0']);
  });

  it.each(['fail', 'fail?'])('leaves a node that every peer who knows it flags %s to topology divergence', (flag) => {
    const down = { flags: ['master', flag], linkState: 'disconnected' };
    const views = [view('p1', { n1: null }), view('p2', { n1: down }), view('p3', { n1: down })];
    const { found, tracked } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toEqual([]);
    expect(unclaimedMemberships(tracked, found)).toEqual(['membership:n1']);
  });

  it('claims a node one peer flags as failing while another does not', () => {
    const views = [view('p1', { n1: null }), view('p2', { n1: { flags: ['master', 'fail?'] } }), view('p3')];
    const { found } = judge(every(views, 0, LONG_ENOUGH));
    expect(found.map((finding) => finding.nodeId)).toEqual(['n1']);
  });

  it('claims a node that answers for itself whatever its peers flag', () => {
    const down = { flags: ['master', 'fail'] };
    const views = [view('p1', { n1: null }), view('p2', { n1: down }), view('n1')];
    const { found } = judge(every(views, 0, LONG_ENOUGH));
    expect(found.map((finding) => finding.nodeId)).toEqual(['n1']);
  });

  describe('when no peer that knows the node gave a view', () => {
    const seen = every([view('p1'), view('p2', { n1: null })], 0, ROUND_MS);
    const unread = every([view('p2', { n1: null }), view('p3', { n1: null })], 2 * ROUND_MS, 3 * ROUND_MS, ['p1']);

    it('does not claim the node without an open event', () => {
      const { found, tracked } = judge([...seen, ...unread]);
      expect(found).toEqual([]);
      expect(unclaimedMemberships(tracked, found)).toEqual(['membership:n1']);
    });

    it('keeps the node of an open event', () => {
      const { found, tracked } = judge([...seen, ...unread], ['n1']);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ nodeId: 'n1', confirmed: false });
      expect(found[0].knownBy).toEqual([]);
      expect(ids(found[0].notKnownBy)).toEqual(['p2']);
      expect(unclaimedMemberships(tracked, found)).toEqual([]);
    });
  });

  it('adds the bus port to the command when it is not the port plus 10000', () => {
    const custom = { address: '10.0.0.7:6379@7000' };
    const views = [view('p1', { n1: custom }), view('p2', { n1: null }), view('p3', { n1: custom })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found[0].meet).toMatchObject({
      ip: '10.0.0.7',
      port: 6379,
      busPort: 7000,
      command: 'CLUSTER MEET 10.0.0.7 6379 7000',
    });
  });

  it('reads an IPv6 address', () => {
    const v6 = { address: '2001:db8::7:6379@16379' };
    const views = [view('p1', { n1: v6 }), view('p2', { n1: null }), view('p3', { n1: v6 })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found[0].meet).toMatchObject({ ip: '2001:db8::7', port: 6379, command: 'CLUSTER MEET 2001:db8::7 6379' });
  });

  it('drops a hostname that follows the address', () => {
    const named = { address: '10.0.0.7:6379@16379,node-7.internal' };
    const views = [view('p1', { n1: named }), view('p2', { n1: null }), view('p3', { n1: named })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found[0].address).toBe('10.0.0.7:6379');
    expect(found[0].meet?.command).toBe('CLUSTER MEET 10.0.0.7 6379');
  });

  it('takes the address most peers reach the node at', () => {
    const moved = { address: '10.0.0.70:6379@16379' };
    const views = [view('p1', { n1: moved }), view('p2', { n1: null }), view('p3'), view('n1', { p2: null })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));
    expect(found[0].address).toBe('10.0.0.7:6379');
  });

  it('takes the address a peer reaches the node at over the one it gives for itself', () => {
    const inner = { address: '10.0.0.200:6379@16379' };
    const views = [view('p1'), view('p2', { n1: null }), view('n1', { n1: inner })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found[0].address).toBe('10.0.0.7:6379');
    expect(found[0].meet?.command).toBe('CLUSTER MEET 10.0.0.7 6379');
  });

  it('takes the address its peers reach a node at when only its own view lacks a peer', () => {
    const inner = { address: '10.0.0.200:6379@16379' };
    const views = [view('p1'), view('p2'), view('p3'), view('n1', { n1: inner, p2: null })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found[0]).toMatchObject({ nodeId: 'n1', address: '10.0.0.7:6379' });
    expect(found[0].meet?.command).toBe('CLUSTER MEET 10.0.0.7 6379');
  });

  it('falls back on the address the node gives for itself when no peer lists it', () => {
    const views = [view('p1', { n1: null }), view('p2', { n1: null }), view('n1')];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found[0].address).toBe('10.0.0.7:6379');
    expect(found[0].meet?.command).toBe('CLUSTER MEET 10.0.0.7 6379');
  });

  it('counts an IPv4 address and its IPv6 mapped form as the same address', () => {
    const mapped = { address: '::ffff:10.0.0.7:6379@16379' };
    const inner = { address: '10.0.0.200:6379@16379' };
    const plain = [view('p1', { n1: mapped }), view('p2', { n1: null }), view('p3'), view('n1', { n1: inner })];
    const both = [view('p1', { n1: mapped }), view('p2', { n1: null }), view('p3', { n1: mapped })];

    expect(judge(every(plain, 0, LONG_ENOUGH)).found[0].address).toBe('10.0.0.7:6379');
    expect(judge(every(both, 0, LONG_ENOUGH)).found[0].meet).toMatchObject({
      ip: '10.0.0.7',
      command: 'CLUSTER MEET 10.0.0.7 6379',
    });
  });

  it('takes the bus port most peers give, whichever view comes first', () => {
    const odd = { address: '10.0.0.7:6379@7000' };
    const usual = { address: '10.0.0.7:6379@7001' };
    const views = [
      view('p1', { n1: odd }),
      view('p2', { n1: null }),
      view('p3', { n1: usual }),
      view('n1', { n1: usual }),
    ];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found[0].meet).toMatchObject({ busPort: 7001, command: 'CLUSTER MEET 10.0.0.7 6379 7001' });
  });

  it('gives no command when no view has an address for the node', () => {
    const views = [view('p1', { n1: null }), view('p2', { n1: null }), view('n1', { n1: { address: ':6379@16379' } })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'n1', address: '', knownBy: [] });
    expect(found[0].meet).toBeUndefined();
  });

  it('gives no command when the address has a name where the IP should be', () => {
    const named = { address: 'node-7.internal:6379@16379' };
    const views = [view('p1', { n1: named }), view('p2', { n1: null }), view('p3', { n1: named })];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ nodeId: 'n1', address: 'node-7.internal:6379', confirmed: true });
    expect(found[0].meet).toBeUndefined();
  });

  it('gives the same findings whichever view comes first', () => {
    const views = [view('p1'), view('p2', { n1: null }), view('p3', { n1: null }), view('n1', { p3: null })];
    const forward = judge(every(views, 0, LONG_ENOUGH)).found;
    const backward = judge(every([...views].reverse(), 0, LONG_ENOUGH)).found;
    expect(backward).toEqual(forward);
  });

  it('reports two half known nodes apart', () => {
    const other = primary('n2', 8, [], 0);
    const views = [
      view('p1', {}, [other]),
      view('p2', { n1: null }, [other]),
      view('p3', {}, []),
    ];
    const { found } = judge(every(views, 0, LONG_ENOUGH));

    expect(found.map((finding) => finding.nodeId)).toEqual(['n1', 'n2']);
    expect(ids(found[0].notKnownBy)).toEqual(['p2']);
    expect(ids(found[1].notKnownBy)).toEqual(['p3']);
  });
});

describe('membershipSightings', () => {
  it('keeps how each view lists a node whose membership is in dispute, and nothing else', () => {
    const views = [
      view('p1'),
      view('p2', { n1: null }, [handshakeWith(NEW_NODE)]),
      view('p3', { n1: withoutAddress(NEW_NODE) }),
    ];
    const sightings = membershipSightings(views, compareTopologyViews(views));

    expect([...sightings.keys()].sort()).toEqual(['n1', 'p2', 'p3']);
    expect(sightings.get('n1')?.map((sighting) => sighting.observerId)).toEqual(['p1']);
  });

  it('keeps how each view lists a node whose own view lacks a peer', () => {
    const views = [view('p1'), view('p2'), view('n1', { p2: null })];
    const sightings = membershipSightings(views, compareTopologyViews(views));

    expect(sightings.get('n1')?.map((sighting) => sighting.observerId)).toEqual(['p1', 'p2', 'n1']);
  });

  it('is empty without a membership disagreement', () => {
    const views = [view('p1'), view('p2', { p3: { flags: ['master', 'fail?'] } })];
    expect(membershipSightings(views, compareTopologyViews(views)).size).toBe(0);
  });
});

describe('partialMembershipSignature', () => {
  it('carries the node id', () => {
    expect(partialMembershipSignature('n1')).toBe('partial_membership:n1');
    expect(partialMembershipNodeId('partial_membership:n1')).toBe('n1');
  });

  it('reads no node id from another key', () => {
    expect(partialMembershipNodeId('topology_divergence:n1')).toBeNull();
    expect(partialMembershipNodeId('partial_membership:')).toBeNull();
    expect(partialMembershipNodeId(undefined)).toBeNull();
  });
});

describe('partialMembershipMessage', () => {
  it('gives a long time in hours and in days', () => {
    const [finding] = judge(every(KNOWN_BY_P1_ONLY, 0, LONG_ENOUGH)).found;
    const since = (ms: number) => partialMembershipMessage(finding, finding.firstSeenAt + ms);

    expect(since(119 * 60_000)).toContain('for 119m.');
    expect(since(6 * 3_600_000)).toContain('for 6h.');
    expect(since(47 * 3_600_000)).toContain('for 47h.');
    expect(since(3 * 86_400_000)).toContain('for 3d.');
  });

  it('names the node, both sets, the command and where to run it', () => {
    const p2 = BASE[1];
    const p3 = BASE[2];
    const views = [
      view('p1'),
      view('p2', { n1: null }),
      view('p3', { n1: null }, [handshakeWith(NEW_NODE)]),
      view('n1', { p2: null, p3: null }, [handshakeWith(p2), handshakeWith(p3)]),
    ];
    const { found } = judge(every(views, 0, 95_000));

    expect(partialMembershipMessage(found[0], 95_000)).toBe(
      'Node 10.0.0.7:6379 has only partly joined the cluster for 95s. ' +
        'Known by 10.0.0.1:6379. ' +
        'Not known by 10.0.0.2:6379 (missing), 10.0.0.3:6379 (stuck in handshake). ' +
        'Its own view is missing 10.0.0.2:6379, 10.0.0.3:6379. ' +
        'Run `CLUSTER MEET 10.0.0.7 6379` on 10.0.0.2:6379 and 10.0.0.3:6379. ' +
        'If it still does not join, check that cluster bus port 16379 is reachable between them. ' +
        'BetterDB does not run this command.',
    );
  });

  it('says so when every sampled peer knows the node', () => {
    const views = [view('p1'), view('p2'), view('p3'), view('n1', { p2: null })];
    const { found } = judge(every(views, 0, 180_000));

    expect(partialMembershipMessage(found[0], 180_000)).toBe(
      'Node 10.0.0.7:6379 has only partly joined the cluster for 3m. ' +
        'Known by 10.0.0.1:6379, 10.0.0.2:6379, 10.0.0.3:6379. ' +
        'Its own view is missing 10.0.0.2:6379. ' +
        'Run `CLUSTER MEET 10.0.0.7 6379` on 10.0.0.2:6379. ' +
        'If it still does not join, check that cluster bus port 16379 is reachable between them. ' +
        'BetterDB does not run this command.',
    );
  });

  it('names a node without an address by its id and gives no command', () => {
    const views = [view('p1', { n1: null }), view('p2', { n1: null }), view('n1', { n1: { address: ':6379@16379' } })];
    const longId = { ...judge(every(views, 0, 95_000)).found[0], nodeId: 'a1b2c3d4e5f6a7b8' };

    expect(partialMembershipMessage(longId, 95_000)).toBe(
      'Node a1b2c3d4 has only partly joined the cluster for 95s. ' +
        'Known by none of the sampled nodes. ' +
        'Not known by 10.0.0.1:6379 (missing), 10.0.0.2:6379 (missing). ' +
        'No view has an address for it, so no CLUSTER MEET command can be given.',
    );
  });

  it('says why there is no command when the address has a name where the IP should be', () => {
    const named = { address: 'node-7.internal:6379@16379' };
    const views = [view('p1', { n1: named }), view('p2', { n1: null }), view('p3', { n1: named })];
    const { found } = judge(every(views, 0, 95_000));

    expect(partialMembershipMessage(found[0], 95_000)).toBe(
      'Node node-7.internal:6379 has only partly joined the cluster for 95s. ' +
        'Known by 10.0.0.1:6379, 10.0.0.3:6379. ' +
        'Not known by 10.0.0.2:6379 (missing). ' +
        'Its address node-7.internal:6379 has a host name where CLUSTER MEET needs an IP address, ' +
        'so no command can be given.',
    );
  });

  it('names a peer that holds the node without an address', () => {
    const views = [view('p1'), view('p2'), view('p3', { n1: withoutAddress(NEW_NODE) })];
    const { found } = judge(every(views, 0, 95_000));
    expect(partialMembershipMessage(found[0], 95_000)).toContain('Not known by 10.0.0.3:6379 (no address).');
  });
});

describe('membershipSides', () => {
  const { found, tracked } = judge(every(KNOWN_BY_P1_ONLY, 0, LONG_ENOUGH));

  it('puts a disagreement a finding holds on the side of its event', () => {
    expect([...membershipSides(tracked, found, LONG_ENOUGH)]).toEqual([['membership:n1', 'partial_membership']]);
  });

  it('puts a disagreement no finding holds on the side of the cluster view divergence event', () => {
    expect([...membershipSides(tracked, [], LONG_ENOUGH)]).toEqual([['membership:n1', 'topology_divergence']]);
  });

  it('keeps the side a disagreement had while it is not seen', () => {
    const before = new Map([['membership:n1', 'partial_membership' as const]]);

    expect([...membershipSides(tracked, [], LONG_ENOUGH + ROUND_MS, before)]).toEqual([
      ['membership:n1', 'partial_membership'],
    ]);
  });

  it('leaves out the other kinds of disagreement', () => {
    const epochs = [view('p1'), view('p2', { p3: { configEpoch: 9 } }), view('p3')];
    const round = judge(every(epochs, 0, LONG_ENOUGH));

    expect(round.tracked.length).toBeGreaterThan(0);
    expect(membershipSides(round.tracked, round.found, LONG_ENOUGH).size).toBe(0);
  });
});

describe('renamedPartialMemberships', () => {
  const [finding] = judge(every(KNOWN_BY_P1_ONLY, 0, LONG_ENOUGH)).found;
  const underOldName = { ...finding, signature: partialMembershipSignature('p9'), nodeId: 'p9' };
  const lacking = underOldName.notKnownBy.map((peer) => peer.nodeId);
  const answered = new Set(['p9', ...lacking]);

  it('names an open finding whose disagreements another finding now holds', () => {
    const open = new Map([[underOldName.signature, { group: underOldName }]]);
    expect(renamedPartialMemberships(open, [finding], answered)).toEqual(['partial_membership:p9']);
  });

  it('leaves a finding whose node gave no view in the round', () => {
    const open = new Map([[underOldName.signature, { group: underOldName }]]);
    expect(renamedPartialMemberships(open, [finding], new Set(lacking))).toEqual([]);
  });

  it('leaves a finding while a peer that lacked its node gave no view in the round', () => {
    const open = new Map([[underOldName.signature, { group: underOldName }]]);
    expect(lacking.length).toBeGreaterThan(0);
    expect(renamedPartialMemberships(open, [finding], new Set(['p9', ...lacking.slice(1)]))).toEqual([]);
  });

  it('leaves a finding that is still found', () => {
    const open = new Map([[finding.signature, { group: finding }]]);
    expect(renamedPartialMemberships(open, [finding], answered)).toEqual([]);
  });

  it('leaves a finding whose disagreements no finding holds', () => {
    const open = new Map([[underOldName.signature, { group: underOldName }]]);
    const elsewhere = [{ ...finding, disagreementKeys: ['membership:p8'] }];
    expect(renamedPartialMemberships(open, [], answered)).toEqual([]);
    expect(renamedPartialMemberships(open, elsewhere, answered)).toEqual([]);
  });

  it('leaves an open event whose finding it never saw', () => {
    expect(renamedPartialMemberships(new Map([[underOldName.signature, {}]]), [finding], answered)).toEqual([]);
  });
});
