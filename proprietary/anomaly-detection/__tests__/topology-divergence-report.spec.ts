import type { ClusterNode } from '@app/common/types/metrics.types';
import type { DivergenceGroup, DivergenceKind, TrackedDisagreement } from '../topology-divergence';
import {
  DIVERGENCE_SEVERITY_BY_KIND,
  buildDivergenceDetail,
  buildPartialMembershipDetail,
  closingPartialMembershipDetail,
  divergenceMessage,
  divergenceSeverity,
  outranksSeverity,
  toDivergenceNode,
} from '../topology-divergence-report';
import type { PartialMembership } from '../partial-membership';
import { AnomalySeverity } from '../types';

function clusterNode(id: string, host: string, zone?: string, patch: Partial<ClusterNode> = {}): ClusterNode {
  return {
    id,
    address: `${host}:6379@16379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [],
    ...(zone ? { availabilityZone: zone } : {}),
    ...patch,
  };
}

const NODES = new Map<string, ClusterNode>(
  [
    clusterNode('a', '10.0.1.5', 'zone a', { shardId: 'shard-1' }),
    clusterNode('b', '10.0.2.7', 'zone b'),
    clusterNode('c', '10.0.3.2', 'zone c'),
    clusterNode('r', '10.0.9.9', undefined, { flags: ['slave'], master: 'a' }),
    ...Array.from({ length: 12 }, (_, i) => clusterNode(`n${i}`, `10.1.0.${i}`)),
  ].map((node) => [node.id, node]),
);

function tracked(kind: DivergenceKind, subject: string, patch: Partial<TrackedDisagreement> = {}): TrackedDisagreement {
  return {
    key: `${kind}:${subject}`,
    kind,
    subjectIds: [subject],
    positions: [
      { value: 'x', observers: ['a'] },
      { value: 'y', observers: ['b', 'c'] },
    ],
    firstSeenAt: 85000,
    lastSeenAt: 100000,
    rounds: 3,
    ...patch,
  };
}

function group(disagreements: TrackedDisagreement[], patch: Partial<DivergenceGroup> = {}): DivergenceGroup {
  return { signature: 'topology_divergence:a', dissent: ['a'], others: ['b', 'c'], disagreements, ...patch };
}

describe('toDivergenceNode', () => {
  it('names a node by id, address, role, shard and zone', () => {
    expect(toDivergenceNode('a', NODES)).toEqual({
      nodeId: 'a',
      address: '10.0.1.5:6379',
      role: 'primary',
      shardId: 'shard-1',
      availabilityZone: 'zone a',
    });
    expect(toDivergenceNode('r', NODES)).toEqual({ nodeId: 'r', address: '10.0.9.9:6379', role: 'replica' });
  });

  it('still names a node no view describes', () => {
    expect(toDivergenceNode('gone', NODES)).toEqual({ nodeId: 'gone', address: '', role: 'unknown' });
  });
});

describe('divergenceMessage', () => {
  it('says who disagrees with whom, about what and for how long', () => {
    const disagreements = [
      ...Array.from({ length: 12 }, (_, i) => tracked('failure_flags', `n${i}`)),
      tracked('slot_owner', 'a|b', { subjectIds: ['a', 'b'], slots: [[0, 5460]] }),
      tracked('config_epoch', 'n1'),
      tracked('config_epoch', 'n2'),
    ];

    expect(divergenceMessage(group(disagreements), NODES, 100000)).toBe(
      'Cluster views diverge for 15s: 10.0.1.5:6379 (zone a) disagrees with 10.0.2.7:6379 (zone b), ' +
        '10.0.3.2:6379 (zone c) about the failure state of 12 nodes, the owner of slots 0-5460 ' +
        'and the config epoch of 2 nodes.',
    );
  });

  it('names the node when the disagreement is about one node', () => {
    expect(divergenceMessage(group([tracked('failure_flags', 'r')]), NODES, 100000)).toBe(
      'Cluster views diverge for 15s: 10.0.1.5:6379 (zone a) disagrees with 10.0.2.7:6379 (zone b), ' +
        '10.0.3.2:6379 (zone c) about the failure state of 10.0.9.9:6379.',
    );
    expect(divergenceMessage(group([tracked('membership', 'r')]), NODES, 100000)).toContain(
      'about whether 10.0.9.9:6379 is a member.',
    );
  });

  it('shortens long lists of nodes and slot ranges', () => {
    const others = Array.from({ length: 8 }, (_, i) => `n${i}`);
    const slots = [[0, 0], [5, 9], [20, 30], [40, 50], [60, 70]];
    const message = divergenceMessage(
      group([tracked('slot_owner', 'a|b', { subjectIds: ['a', 'b'], slots })], { others }),
      NODES,
      400000,
    );

    expect(message).toBe(
      'Cluster views diverge for 5m: 10.0.1.5:6379 (zone a) disagrees with 10.1.0.0:6379, 10.1.0.1:6379, ' +
        '10.1.0.2:6379, 10.1.0.3:6379, 10.1.0.4:6379 +3 more about the owner of slots 0, 5-9, 20-30 +2 more ranges.',
    );
  });

  it('falls back to the node id when no view gives an address', () => {
    expect(divergenceMessage(group([tracked('config_epoch', 'b')], { dissent: ['0123456789abcdef'] }), NODES, 100000))
      .toContain('01234567 disagrees with');
  });
});

describe('DIVERGENCE_SEVERITY_BY_KIND', () => {
  it('is critical for disputed slot owners and a warning for the rest', () => {
    expect(DIVERGENCE_SEVERITY_BY_KIND).toEqual({
      slot_owner: AnomalySeverity.CRITICAL,
      failure_flags: AnomalySeverity.WARNING,
      membership: AnomalySeverity.WARNING,
      config_epoch: AnomalySeverity.WARNING,
    });
  });
});

describe('outranksSeverity', () => {
  it('is true only for a strictly higher severity', () => {
    expect(outranksSeverity(AnomalySeverity.CRITICAL, AnomalySeverity.WARNING)).toBe(true);
    expect(outranksSeverity(AnomalySeverity.WARNING, AnomalySeverity.WARNING)).toBe(false);
    expect(outranksSeverity(AnomalySeverity.WARNING, AnomalySeverity.CRITICAL)).toBe(false);
  });
});

describe('divergenceSeverity', () => {
  it('takes the highest severity among the kinds in dispute', () => {
    const kinds: DivergenceKind[] = ['slot_owner', 'failure_flags', 'membership', 'config_epoch'];
    for (const kind of kinds) {
      expect(divergenceSeverity(group([tracked(kind, 'b')]))).toBe(DIVERGENCE_SEVERITY_BY_KIND[kind]);
    }
    expect(divergenceSeverity(group([tracked('config_epoch', 'b'), tracked('membership', 'c')]))).toBe(
      AnomalySeverity.WARNING,
    );
  });

  it('is critical when slot owners are in dispute and a warning otherwise', () => {
    expect(divergenceSeverity(group([tracked('failure_flags', 'b')]))).toBe(AnomalySeverity.WARNING);
    expect(
      divergenceSeverity(group([tracked('failure_flags', 'b'), tracked('slot_owner', 'a|b', { slots: [[1, 2]] })])),
    ).toBe(AnomalySeverity.CRITICAL);
  });
});

describe('buildDivergenceDetail', () => {
  it('lays out both sides and every disagreement with named nodes', () => {
    const detail = buildDivergenceDetail(
      group([
        tracked('failure_flags', 'r', { firstSeenAt: 90000 }),
        tracked('slot_owner', 'a|b', { subjectIds: ['a', 'b'], slots: [[0, 10]], rounds: 5 }),
      ]),
      NODES,
      { eventId: 'evt-1', confirmed: true },
    );

    expect(detail).toMatchObject({
      eventId: 'evt-1',
      confirmed: true,
      since: 85000,
      sides: [
        { nodes: [{ nodeId: 'a', availabilityZone: 'zone a' }] },
        { nodes: [{ nodeId: 'b' }, { nodeId: 'c' }] },
      ],
    });
    expect(detail.disagreements).toEqual([
      {
        kind: 'failure_flags',
        subject: [{ nodeId: 'r', address: '10.0.9.9:6379', role: 'replica' }],
        positions: [
          { value: 'x', observers: [toDivergenceNode('a', NODES)] },
          { value: 'y', observers: [toDivergenceNode('b', NODES), toDivergenceNode('c', NODES)] },
        ],
        rounds: 3,
        since: 90000,
        eventId: 'evt-1',
        eventType: 'topology_divergence',
      },
      {
        kind: 'slot_owner',
        subject: [toDivergenceNode('a', NODES), toDivergenceNode('b', NODES)],
        slots: [[0, 10]],
        positions: [
          { value: 'x', observers: [toDivergenceNode('a', NODES)] },
          { value: 'y', observers: [toDivergenceNode('b', NODES), toDivergenceNode('c', NODES)] },
        ],
        rounds: 5,
        since: 85000,
        eventId: 'evt-1',
        eventType: 'topology_divergence',
      },
    ]);
  });

  it('names no event on a disagreement that is still being counted', () => {
    const detail = buildDivergenceDetail(group([tracked('config_epoch', 'b')]), NODES, {
      eventId: null,
      confirmed: false,
    });

    expect(detail.disagreements).toMatchObject([{ kind: 'config_epoch', eventId: null, eventType: null }]);
  });
});

describe('buildPartialMembershipDetail', () => {
  const membership = tracked('membership', 'n0', {
    positions: [
      { value: 'known', observers: ['a'] },
      { value: 'handshake', observers: ['b'] },
      { value: 'missing', observers: ['c'] },
    ],
    rounds: 20,
  });
  const finding: PartialMembership = {
    signature: 'partial_membership:n0',
    nodeId: 'n0',
    address: '10.9.9.9:7000',
    knownBy: [{ nodeId: 'a', address: '10.0.1.5:6379' }],
    notKnownBy: [
      { nodeId: 'b', address: '10.0.2.7:6379', status: 'handshake' },
      { nodeId: 'c', address: '10.0.3.2:6379', status: 'missing' },
    ],
    ownViewMissing: [{ nodeId: 'c', address: '10.0.3.2:6379', status: 'noaddr' }],
    disagreementKeys: ['membership:n0'],
    slotDisputeKeys: [],
    firstSeenAt: 85000,
    rounds: 20,
    confirmed: true,
    meet: {
      ip: '10.9.9.9',
      port: 7000,
      busPort: 17000,
      command: 'CLUSTER MEET 10.9.9.9 7000',
      runOn: [
        { nodeId: 'b', address: '10.0.2.7:6379' },
        { nodeId: 'c', address: '10.0.3.2:6379' },
      ],
    },
  };

  it('lays out the node, both sets of peers and the command', () => {
    const detail = buildPartialMembershipDetail(finding, [tracked('config_epoch', 'b'), membership], NODES, {
      eventId: 'evt-2',
      confirmed: true,
    });

    expect(detail).toEqual({
      eventId: 'evt-2',
      confirmed: true,
      seen: true,
      since: 85000,
      node: { nodeId: 'n0', address: '10.9.9.9:7000', role: 'primary' },
      knownBy: [toDivergenceNode('a', NODES)],
      notKnownBy: [
        { ...toDivergenceNode('b', NODES), status: 'handshake' },
        { ...toDivergenceNode('c', NODES), status: 'missing' },
      ],
      ownViewMissing: [{ ...toDivergenceNode('c', NODES), status: 'noaddr' }],
      command: 'CLUSTER MEET 10.9.9.9 7000',
      runOn: [toDivergenceNode('b', NODES), toDivergenceNode('c', NODES)],
      disagreements: [
        {
          kind: 'membership',
          subject: [toDivergenceNode('n0', NODES)],
          positions: [
            { value: 'known', observers: [toDivergenceNode('a', NODES)] },
            { value: 'handshake', observers: [toDivergenceNode('b', NODES)] },
            { value: 'missing', observers: [toDivergenceNode('c', NODES)] },
          ],
          rounds: 20,
          since: 85000,
          eventId: 'evt-2',
          eventType: 'partial_membership',
        },
      ],
    });
  });

  it('gives no command when the node has no address, and no event while it is still counted', () => {
    const { meet: _meet, ...unreachable } = finding;
    const detail = buildPartialMembershipDetail(
      { ...unreachable, nodeId: 'zz', address: '', confirmed: false },
      [membership],
      NODES,
      { eventId: null, confirmed: false },
    );

    expect(detail).toMatchObject({
      eventId: null,
      confirmed: false,
      node: { nodeId: 'zz', address: '', role: 'unknown' },
      command: null,
      runOn: [],
      disagreements: [{ kind: 'membership', eventId: null, eventType: null }],
    });
  });

  it('gives no command for a node whose address has a host name, and still gives the address', () => {
    const { meet: _meet, ...named } = finding;
    const detail = buildPartialMembershipDetail({ ...named, address: 'redis-7.svc:6379' }, [membership], NODES, {
      eventId: 'evt-2',
      confirmed: true,
    });

    expect(detail).toMatchObject({ node: { nodeId: 'n0', address: 'redis-7.svc:6379' }, command: null, runOn: [] });
  });

});

describe('closingPartialMembershipDetail', () => {
  const finding: PartialMembership = {
    signature: 'partial_membership:n0',
    nodeId: 'n0',
    address: '10.9.9.9:7000',
    knownBy: [{ nodeId: 'a', address: '10.0.1.5:6379' }],
    notKnownBy: [{ nodeId: 'b', address: '10.0.2.7:6379', status: 'missing' }],
    ownViewMissing: [{ nodeId: 'c', address: '10.0.3.2:6379', status: 'noaddr' }],
    disagreementKeys: ['membership:n0'],
    slotDisputeKeys: [],
    firstSeenAt: 85000,
    rounds: 20,
    confirmed: true,
    meet: {
      ip: '10.9.9.9',
      port: 7000,
      busPort: 17000,
      command: 'CLUSTER MEET 10.9.9.9 7000',
      runOn: [{ nodeId: 'b', address: '10.0.2.7:6379' }],
    },
  };

  it('keeps the node and its event, and none of the peers, the command or the disagreements', () => {
    expect(closingPartialMembershipDetail(finding, NODES, 'evt-2')).toEqual({
      eventId: 'evt-2',
      confirmed: true,
      seen: false,
      since: 85000,
      node: { nodeId: 'n0', address: '10.9.9.9:7000', role: 'primary' },
      knownBy: [],
      notKnownBy: [],
      ownViewMissing: [],
      command: null,
      runOn: [],
      disagreements: [],
    });
  });
});
