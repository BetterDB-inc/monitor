import type { ClusterNode } from '@app/common/types/metrics.types';
import type { DivergenceGroup, DivergenceKind, TrackedDisagreement } from '../topology-divergence';
import {
  DIVERGENCE_SEVERITY_BY_KIND,
  buildDivergenceDetail,
  divergenceMessage,
  divergenceSeverity,
  toDivergenceNode,
} from '../topology-divergence-report';
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
      },
    ]);
  });
});
