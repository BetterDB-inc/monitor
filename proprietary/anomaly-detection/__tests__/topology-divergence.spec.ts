import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  DivergenceTracker,
  TOPOLOGY_DIVERGENCE_BLIND_MS,
  type TopologyDisagreement,
  type TopologyView,
  compareTopologyViews,
  confirmedDisagreements,
  dissentOf,
  groupDivergences,
  migrationTouchesSlots,
  type OpenDivergence,
  settleOpenDivergences,
} from '../topology-divergence';

type NodePatch = Partial<ClusterNode> | null;

const BASE: ClusterNode[] = [
  primary('p1', 1, [[0, 5460]], 1),
  primary('p2', 2, [[5461, 10922]], 2),
  primary('p3', 3, [[10923, 16383]], 3),
  replica('r1', 4, 'p1', 1),
  replica('r2', 5, 'p2', 2),
  replica('r3', 6, 'p3', 3),
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

function replica(id: string, host: number, master: string, configEpoch: number): ClusterNode {
  return { ...primary(id, host, [], configEpoch), flags: ['slave'], master };
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

function failing(flag: 'fail' | 'fail?' = 'fail?'): Partial<ClusterNode> {
  return { flags: ['master', flag] };
}

function byKey(disagreements: TopologyDisagreement[], key: string): TopologyDisagreement {
  const found = disagreements.find((d) => d.key === key);
  if (!found) throw new Error(`no disagreement ${key} in ${disagreements.map((d) => d.key).join(', ')}`);
  return found;
}

describe('compareTopologyViews', () => {
  it('reports nothing when every view agrees', () => {
    expect(compareTopologyViews([view('p1'), view('p2'), view('p3')])).toEqual([]);
  });

  it('reports nothing from a single view', () => {
    expect(compareTopologyViews([view('p1', { p2: failing() })])).toEqual([]);
  });

  it('names who sees a node as failing and who does not', () => {
    const found = compareTopologyViews([view('p1', { p3: failing() }), view('p2'), view('r1')]);

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      key: 'failure_flags:p3',
      kind: 'failure_flags',
      subjectIds: ['p3'],
      positions: [
        { value: 'failing', observers: ['p1'] },
        { value: 'ok', observers: ['p2', 'r1'] },
      ],
    });
  });

  it('treats fail? and fail as the same side', () => {
    const found = compareTopologyViews([
      view('p1', { p3: failing('fail') }),
      view('p2', { p3: failing('fail?') }),
    ]);

    expect(found).toEqual([]);
  });

  it('reports fail? against fail only when another observer says ok', () => {
    const found = compareTopologyViews([
      view('p1', { p3: failing('fail') }),
      view('p2', { p3: failing('fail?') }),
      view('r1'),
    ]);

    expect(found).toEqual([
      {
        key: 'failure_flags:p3',
        kind: 'failure_flags',
        subjectIds: ['p3'],
        positions: [
          { value: 'failing', observers: ['p1', 'p2'] },
          { value: 'ok', observers: ['r1'] },
        ],
      },
    ]);
  });

  it('reads a node every observer flags as agreement', () => {
    const found = compareTopologyViews([
      view('p1', { p3: failing('fail?') }),
      view('p2', { p3: failing('fail') }),
      view('r1', { p3: failing('fail?') }),
      view('r2', { p3: failing('fail') }),
    ]);

    expect(found).toEqual([]);
  });

  it('gives the same answer whichever view comes first', () => {
    const views = [view('p1', { p3: failing() }), view('p2'), view('r1', { p3: failing() }), view('r2')];

    expect(compareTopologyViews([...views].reverse())).toEqual(compareTopologyViews(views));
    expect(compareTopologyViews([views[2], views[0], views[3], views[1]])).toEqual(compareTopologyViews(views));
  });

  it('leaves a node out of the vote on its own failure', () => {
    const found = compareTopologyViews([
      view('p1', { p3: failing('fail') }),
      view('p2', { p3: failing('fail') }),
      view('p3'),
    ]);

    expect(found.filter((d) => d.kind === 'failure_flags')).toEqual([]);
  });

  it('reports a config epoch that differs between views', () => {
    const found = compareTopologyViews([view('p1'), view('p2', { p3: { configEpoch: 9 } }), view('r1')]);

    expect(found).toEqual([
      {
        key: 'config_epoch:p3',
        kind: 'config_epoch',
        subjectIds: ['p3'],
        positions: [
          { value: '3', observers: ['p1', 'r1'] },
          { value: '9', observers: ['p2'] },
        ],
      },
    ]);
  });

  it('reports the slots two views give to different owners', () => {
    const promoted = {
      p1: { slots: [] as number[][] },
      r1: { flags: ['master'], master: '-', slots: [[0, 5460]], configEpoch: 7 },
    };
    const found = compareTopologyViews([view('p2', promoted), view('p3', promoted), view('p1')]);

    expect(byKey(found, 'slot_owner:p1|r1')).toEqual({
      key: 'slot_owner:p1|r1',
      kind: 'slot_owner',
      subjectIds: ['p1', 'r1'],
      slots: [[0, 5460]],
      positions: [
        { value: 'p1', observers: ['p1'] },
        { value: 'r1', observers: ['p2', 'p3'] },
      ],
    });
  });

  it('never puts one observer on both sides when two views swap claims on different slots', () => {
    const swapped = {
      p1: { slots: [[1, 5460], [5461, 5461]] },
      p2: { slots: [[0, 0], [5462, 10922]] },
    };
    const found = compareTopologyViews([view('p1'), view('p2', swapped), view('p3')]);

    expect(found).toEqual([
      {
        key: 'slot_owner:p1|p2',
        kind: 'slot_owner',
        subjectIds: ['p1', 'p2'],
        slots: [[0, 0]],
        positions: [
          { value: 'p1', observers: ['p1', 'p3'] },
          { value: 'p2', observers: ['p2'] },
        ],
      },
      {
        key: 'slot_owner:p1|p2#2',
        kind: 'slot_owner',
        subjectIds: ['p1', 'p2'],
        slots: [[5461, 5461]],
        positions: [
          { value: 'p1', observers: ['p2'] },
          { value: 'p2', observers: ['p1', 'p3'] },
        ],
      },
    ]);
    expect(compareTopologyViews([view('p3'), view('p2', swapped), view('p1')])).toEqual(found);

    const tracker = new DivergenceTracker();
    tracker.observe({ at: 1000, disagreements: found, unanswered: [], views: 3 });
    expect(groupDivergences(tracker.tracked())).toMatchObject([
      { signature: 'topology_divergence:p2', dissent: ['p2'], others: ['p1', 'p3'] },
    ]);
  });

  it('reports only the slots in dispute, as ranges', () => {
    const moved = {
      p1: { slots: [[0, 99], [201, 5460]] },
      p2: { slots: [[100, 200], [5461, 10922]] },
    };
    const found = compareTopologyViews([view('p1'), view('p2', moved)]);

    expect(byKey(found, 'slot_owner:p1|p2').slots).toEqual([[100, 200]]);
  });

  it('reports a slot one view leaves unassigned', () => {
    const found = compareTopologyViews([view('p1'), view('p2', { p3: { slots: [[10923, 16382]] } })]);

    const dispute = byKey(found, 'slot_owner:p3|unassigned');
    expect(dispute.subjectIds).toEqual(['p3']);
    expect(dispute.slots).toEqual([[16383, 16383]]);
    expect(dispute.positions).toEqual([
      { value: 'p3', observers: ['p1'] },
      { value: 'unassigned', observers: ['p2'] },
    ]);
  });

  it('reports a node only some views know', () => {
    const found = compareTopologyViews([view('p1'), view('p2', { r3: null }), view('p3')]);

    expect(found).toEqual([
      {
        key: 'membership:r3',
        kind: 'membership',
        subjectIds: ['r3'],
        positions: [
          { value: 'known', observers: ['p1', 'p3'] },
          { value: 'missing', observers: ['p2'] },
        ],
      },
    ]);
  });

  it('matches a handshake entry to the real node by address', () => {
    const stuck: ClusterNode = { ...replica('f00d', 6, '-', 0), flags: ['handshake'] };
    const found = compareTopologyViews([view('p1'), view('p2', { r3: null }, [stuck])]);

    expect(found).toHaveLength(1);
    expect(found[0].key).toBe('membership:r3');
    expect(found[0].subjectIds).toEqual(['r3']);
    expect(found[0].positions).toEqual([
      { value: 'handshake', observers: ['p2'] },
      { value: 'known', observers: ['p1'] },
    ]);
  });

  it('never makes a subject of the temporary id of a handshake entry', () => {
    const stuck: ClusterNode = { ...replica('f00d', 6, '-', 9), flags: ['handshake', 'fail?'] };
    const found = compareTopologyViews([
      view('p1'),
      view('p2', { r3: null }, [stuck]),
      view('p3', {}, [{ ...stuck, id: 'cafe' }]),
    ]);

    expect(found.map((d) => d.key)).toEqual(['membership:r3']);
    expect(found.flatMap((d) => d.subjectIds)).toEqual(['r3']);
  });

  it('reports a node one view holds without an address', () => {
    const found = compareTopologyViews([view('p1'), view('p2', { r3: { flags: ['slave', 'noaddr'] } })]);

    expect(byKey(found, 'membership:r3').positions).toEqual([
      { value: 'known', observers: ['p1'] },
      { value: 'noaddr', observers: ['p2'] },
    ]);
  });

  it('ignores a handshake entry no view knows by its real id', () => {
    const stranger: ClusterNode = { ...replica('beef', 99, '-', 0), flags: ['handshake'] };

    expect(compareTopologyViews([view('p1', {}, [stranger]), view('p2')])).toEqual([]);
  });

  it('matches no handshake entry to an address two node ids share', () => {
    const replaced = replica('new3', 6, 'p3', 3);
    const stuck: ClusterNode = { ...replica('f00d', 6, '-', 0), flags: ['handshake'] };
    const old = view('p1');
    const fresh = view('p2', { r3: null }, [replaced]);
    const meeting = view('p3', { r3: null }, [stuck]);

    const found = compareTopologyViews([old, fresh, meeting]);

    expect(compareTopologyViews([fresh, old, meeting])).toEqual(found);
    expect(found.map((d) => d.key)).toEqual(['membership:new3', 'membership:r3']);
    expect(found.flatMap((d) => d.positions.map((position) => position.value))).not.toContain('handshake');
  });

  it('describes an isolated node as one observer against the rest', () => {
    const everyoneElseFailing = {
      p2: failing(),
      p3: failing(),
      r1: { flags: ['slave', 'fail?'] },
      r2: { flags: ['slave', 'fail?'] },
      r3: { flags: ['slave', 'fail?'] },
    };
    const found = compareTopologyViews([
      view('p1', everyoneElseFailing),
      view('p2', { p1: failing('fail') }),
      view('p3', { p1: failing('fail') }),
    ]);

    expect(found.map((d) => d.key).sort()).toEqual([
      'failure_flags:p2',
      'failure_flags:p3',
      'failure_flags:r1',
      'failure_flags:r2',
      'failure_flags:r3',
    ]);
    expect(new Set(found.map((d) => dissentOf(d).join(',')))).toEqual(new Set(['p1']));
  });
});

describe('dissentOf', () => {
  const disagreement = (positions: TopologyDisagreement['positions']): TopologyDisagreement => ({
    key: 'failure_flags:x',
    kind: 'failure_flags',
    subjectIds: ['x'],
    positions,
  });

  it('is the smaller side', () => {
    expect(
      dissentOf(
        disagreement([
          { value: 'failing', observers: ['b', 'c'] },
          { value: 'ok', observers: ['a'] },
        ]),
      ),
    ).toEqual(['a']);
  });

  it('breaks a tie the same way whichever side holds which value', () => {
    const one = dissentOf(
      disagreement([
        { value: 'failing', observers: ['b'] },
        { value: 'ok', observers: ['a'] },
      ]),
    );
    const other = dissentOf(
      disagreement([
        { value: 'failing', observers: ['a'] },
        { value: 'ok', observers: ['b'] },
      ]),
    );

    expect(one).toEqual(['a']);
    expect(other).toEqual(['a']);
  });

  it('is everyone outside the largest side when there are three', () => {
    expect(
      dissentOf(
        disagreement([
          { value: '1', observers: ['a', 'b', 'c'] },
          { value: '2', observers: ['e'] },
          { value: '3', observers: ['d'] },
        ]),
      ),
    ).toEqual(['d', 'e']);
  });
});

describe('DivergenceTracker', () => {
  const flags = (subject: string, failingBy: string[], okBy: string[]): TopologyDisagreement => ({
    key: `failure_flags:${subject}`,
    kind: 'failure_flags',
    subjectIds: [subject],
    positions: [
      { value: 'failing', observers: failingBy },
      { value: 'ok', observers: okBy },
    ],
  });
  const slots = (ranges: number[][]): TopologyDisagreement => ({
    key: 'slot_owner:p1|p2',
    kind: 'slot_owner',
    subjectIds: ['p1', 'p2'],
    slots: ranges,
    positions: [
      { value: 'p1', observers: ['a'] },
      { value: 'p2', observers: ['b'] },
    ],
  });
  const round = (at: number, disagreements: TopologyDisagreement[], unanswered: string[] = [], views = 3) => ({
    at,
    disagreements,
    unanswered,
    views,
  });

  it('counts the rounds a disagreement was seen in a row', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(6000, [flags('x', ['a'], ['b', 'c'])]));

    expect(tracker.tracked()).toEqual([
      { ...flags('x', ['a'], ['b', 'c']), firstSeenAt: 1000, lastSeenAt: 6000, rounds: 2 },
    ]);
  });

  it('starts over after a round without the disagreement', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(6000, []));
    tracker.observe(round(11000, [flags('x', ['a'], ['b', 'c'])]));

    expect(tracker.tracked()).toMatchObject([{ firstSeenAt: 11000, rounds: 1 }]);
  });

  it('keeps the latest sides of a disagreement', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(6000, [flags('x', ['a', 'b'], ['c'])]));

    expect(tracker.tracked()[0].positions[0].observers).toEqual(['a', 'b']);
  });

  it('counts a slot dispute only while the same slots stay in dispute', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [slots([[100, 200]])]));
    tracker.observe(round(6000, [slots([[150, 300]])]));
    expect(tracker.tracked()).toMatchObject([{ rounds: 2, slots: [[150, 200]] }]);

    tracker.observe(round(11000, [slots([[400, 400]])]));
    expect(tracker.tracked()).toMatchObject([{ rounds: 1, firstSeenAt: 11000, slots: [[400, 400]] }]);
  });

  it('holds every count through a round with fewer than two views', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(6000, [], [], 1));
    tracker.observe(round(11000, [flags('x', ['a'], ['b', 'c'])]));

    expect(tracker.tracked()).toMatchObject([{ firstSeenAt: 1000, rounds: 2 }]);
  });

  it('holds a count while a dissenting observer does not answer', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(6000, [], ['a']));
    expect(tracker.tracked()).toMatchObject([{ firstSeenAt: 1000, rounds: 1 }]);

    tracker.observe(round(11000, [], ['c']));
    expect(tracker.tracked()).toEqual([]);
  });

  it('neither grows nor resets a count in a round one side gave no view', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(6000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(11000, [], ['a']));
    tracker.observe(round(16000, [], ['a']));
    expect(tracker.tracked()).toMatchObject([{ firstSeenAt: 1000, lastSeenAt: 6000, rounds: 2 }]);

    tracker.observe(round(21000, [flags('x', ['a'], ['b', 'c'])]));
    expect(tracker.tracked()).toMatchObject([{ firstSeenAt: 1000, lastSeenAt: 21000, rounds: 3 }]);
  });

  it('forgets what it could not see again within the blind limit', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [flags('x', ['a'], ['b', 'c'])]));
    tracker.observe(round(1000 + TOPOLOGY_DIVERGENCE_BLIND_MS, [], [], 1));
    expect(tracker.tracked()).toHaveLength(1);

    tracker.observe(round(1001 + TOPOLOGY_DIVERGENCE_BLIND_MS, [], [], 1));
    expect(tracker.tracked()).toEqual([]);
  });

  it('starts a count over on request', () => {
    const tracker = new DivergenceTracker();

    tracker.observe(round(1000, [slots([[100, 200]])]));
    tracker.observe(round(6000, [slots([[100, 200]])]));
    tracker.restart('slot_owner:p1|p2');
    tracker.observe(round(11000, [slots([[100, 200]])]));

    expect(tracker.tracked()).toMatchObject([{ firstSeenAt: 11000, rounds: 1 }]);
  });
});

describe('confirmedDisagreements', () => {
  const tracked = (kind: TopologyDisagreement['kind'], rounds: number, firstSeenAt: number) => ({
    key: `${kind}:x`,
    kind,
    subjectIds: ['x'],
    positions: [
      { value: '1', observers: ['a'] },
      { value: '2', observers: ['b', 'c'] },
    ],
    firstSeenAt,
    lastSeenAt: 20000,
    rounds,
  });

  it('confirms after the required rounds', () => {
    const rule = { minRounds: 3 };

    expect(confirmedDisagreements([tracked('config_epoch', 2, 10000)], 20000, rule)).toEqual([]);
    expect(confirmedDisagreements([tracked('config_epoch', 3, 10000)], 20000, rule)).toHaveLength(1);
  });

  it('also waits for the minimum age of the kind', () => {
    const rule = { minRounds: 3, minAgeMs: { membership: 60000 } };

    const seenAt = (lastSeenAt: number) => ({ ...tracked('membership', 5, 0), lastSeenAt });

    expect(confirmedDisagreements([seenAt(59999)], 59999, rule)).toEqual([]);
    expect(confirmedDisagreements([seenAt(60000)], 60000, rule)).toHaveLength(1);
    expect(confirmedDisagreements([tracked('config_epoch', 5, 0)], 20000, rule)).toHaveLength(1);
  });

  it('does not confirm what the latest round did not see', () => {
    const stale = { ...tracked('config_epoch', 5, 0), lastSeenAt: 15000 };

    expect(confirmedDisagreements([stale], 20000, { minRounds: 3 })).toEqual([]);
  });
});

describe('groupDivergences', () => {
  const tracked = (key: string, positions: TopologyDisagreement['positions']) => ({
    key,
    kind: 'failure_flags' as const,
    subjectIds: [key.split(':')[1]],
    positions,
    firstSeenAt: 0,
    lastSeenAt: 10000,
    rounds: 3,
  });

  it('puts everything one observer disagrees about into one group', () => {
    const groups = groupDivergences([
      tracked('failure_flags:p2', [
        { value: 'failing', observers: ['p1'] },
        { value: 'ok', observers: ['p3'] },
      ]),
      tracked('failure_flags:p3', [
        { value: 'failing', observers: ['p1'] },
        { value: 'ok', observers: ['p2'] },
      ]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      signature: 'topology_divergence:p1',
      dissent: ['p1'],
      others: ['p2', 'p3'],
    });
    expect(groups[0].disagreements.map((d) => d.key)).toEqual(['failure_flags:p2', 'failure_flags:p3']);
  });

  it('keeps different dissenters apart', () => {
    const groups = groupDivergences([
      tracked('failure_flags:x', [
        { value: 'failing', observers: ['a'] },
        { value: 'ok', observers: ['b', 'c'] },
      ]),
      tracked('failure_flags:y', [
        { value: 'failing', observers: ['c'] },
        { value: 'ok', observers: ['a', 'b'] },
      ]),
    ]);

    expect(groups.map((g) => g.signature)).toEqual(['topology_divergence:a', 'topology_divergence:c']);
  });

  it('settles a one-against-one split by the observer the other splits single out', () => {
    const groups = groupDivergences([
      tracked('failure_flags:p1', [
        { value: 'failing', observers: ['p3'] },
        { value: 'ok', observers: ['p2'] },
      ]),
      tracked('failure_flags:p2', [
        { value: 'failing', observers: ['p3'] },
        { value: 'ok', observers: ['p1'] },
      ]),
      tracked('failure_flags:r1', [
        { value: 'failing', observers: ['p3'] },
        { value: 'ok', observers: ['p1', 'p2'] },
      ]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ signature: 'topology_divergence:p3', dissent: ['p3'], others: ['p1', 'p2'] });
  });

  it('names a tie of equal sides the same way whichever observer answers first', () => {
    const signatureOf = (views: TopologyView[]) => {
      const tracker = new DivergenceTracker();
      tracker.observe({ at: 1000, disagreements: compareTopologyViews(views), unanswered: [], views: views.length });
      return groupDivergences(tracker.tracked()).map((group) => [group.signature, group.dissent, group.others]);
    };
    const pair = [view('p1', { p3: failing() }), view('p2')];
    const four = [view('p1', { p3: failing() }), view('p2', { p3: failing() }), view('r1'), view('r2')];

    expect(signatureOf(pair)).toEqual([['topology_divergence:p1', ['p1'], ['p2']]]);
    expect(signatureOf([...pair].reverse())).toEqual(signatureOf(pair));
    expect(signatureOf(four)).toEqual([['topology_divergence:p1,p2', ['p1', 'p2'], ['r1', 'r2']]]);
    expect(signatureOf([four[3], four[1], four[2], four[0]])).toEqual(signatureOf(four));
  });

  it('groups ties the same way whichever order they come in', () => {
    const first = tracked('failure_flags:x', [
      { value: 'failing', observers: ['a'] },
      { value: 'ok', observers: ['b'] },
    ]);
    const second = tracked('failure_flags:y', [
      { value: 'failing', observers: ['b'] },
      { value: 'ok', observers: ['c'] },
    ]);
    const signaturesOf = (order: Array<typeof first>) => groupDivergences(order).map((group) => group.signature);

    expect(signaturesOf([first, second])).toEqual(['topology_divergence:a', 'topology_divergence:b']);
    expect(signaturesOf([second, first])).toEqual(signaturesOf([first, second]));
  });

  it('keeps the name of a tie when the sides swap what they claim', () => {
    const before = groupDivergences([
      tracked('failure_flags:x', [
        { value: 'failing', observers: ['a'] },
        { value: 'ok', observers: ['b'] },
      ]),
    ]);
    const after = groupDivergences([
      tracked('failure_flags:x', [
        { value: 'failing', observers: ['b'] },
        { value: 'ok', observers: ['a'] },
      ]),
    ]);

    expect(after[0].signature).toBe(before[0].signature);
  });

  it('makes one group of a two-sided partition', () => {
    const groups = groupDivergences([
      tracked('failure_flags:zone-a-node', [
        { value: 'failing', observers: ['b', 'c'] },
        { value: 'ok', observers: ['a'] },
      ]),
      tracked('failure_flags:zone-b-node', [
        { value: 'failing', observers: ['a'] },
        { value: 'ok', observers: ['b', 'c'] },
      ]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ dissent: ['a'], others: ['b', 'c'] });
  });
});

describe('migrationTouchesSlots', () => {
  const owner = primary('p1', 1, [[0, 5460]], 1);

  it('is false without any migration', () => {
    expect(migrationTouchesSlots([[100, 200]], owner, [])).toBe(false);
    expect(migrationTouchesSlots([[100, 200]], null, [])).toBe(false);
  });

  it('sees a slot the owner marks as migrating or importing', () => {
    const migrating = { ...owner, migratingSlots: [{ slot: 150, targetNodeId: 'p2' }] };
    const importing = { ...owner, importingSlots: [{ slot: 100, sourceNodeId: 'p2' }] };
    const elsewhere = { ...owner, migratingSlots: [{ slot: 900, targetNodeId: 'p2' }] };

    expect(migrationTouchesSlots([[100, 200]], migrating, [])).toBe(true);
    expect(migrationTouchesSlots([[100, 200]], importing, [])).toBe(true);
    expect(migrationTouchesSlots([[100, 200]], elsewhere, [])).toBe(false);
  });

  it('sees a running migration job over the disputed slots', () => {
    const job = (state: string, slot_ranges: string) => ({ name: 'job', state, slot_ranges });

    expect(migrationTouchesSlots([[100, 200]], owner, [job('snapshotting', '0-99 180-300')])).toBe(true);
    expect(migrationTouchesSlots([[100, 200]], owner, [job('snapshotting', '201-300')])).toBe(false);
    expect(migrationTouchesSlots([[100, 200]], owner, [job('success', '100-200')])).toBe(false);
    expect(migrationTouchesSlots([[150, 150]], owner, [job('paused', '150')])).toBe(true);
  });
});

describe('settleOpenDivergences', () => {
  const SIGNATURE = 'topology_divergence:a';
  const confirmedGroup = { signature: SIGNATURE, dissent: ['a'], others: ['b', 'c'], disagreements: [] };
  const settle = (open: Map<string, OpenDivergence>, at: number, patch: Record<string, unknown> = {}) =>
    settleOpenDivergences({
      open,
      openSignatures: [SIGNATURE],
      confirmed: [],
      pendingSignatures: new Set<string>(),
      comparable: true,
      at,
      minRounds: 3,
      ...patch,
    });

  it('keeps an event open until the views agreed for the required rounds', () => {
    const open = new Map<string, OpenDivergence>();
    settle(open, 0, { confirmed: [confirmedGroup] });

    expect(settle(open, 5000).has(SIGNATURE)).toBe(true);
    expect(settle(open, 10000).has(SIGNATURE)).toBe(true);
    expect(settle(open, 15000).has(SIGNATURE)).toBe(false);
  });

  it('starts the clean count over when the divergence is confirmed again', () => {
    const open = new Map<string, OpenDivergence>();
    settle(open, 0, { confirmed: [confirmedGroup] });
    settle(open, 5000);
    settle(open, 10000);
    settle(open, 15000, { confirmed: [confirmedGroup] });

    expect(settle(open, 20000).has(SIGNATURE)).toBe(true);
    expect(settle(open, 25000).has(SIGNATURE)).toBe(true);
    expect(settle(open, 30000).has(SIGNATURE)).toBe(false);
    expect(open.get(SIGNATURE)?.group).toBe(confirmedGroup);
  });

  it('does not count a round it could not compare as clean', () => {
    const open = new Map<string, OpenDivergence>();
    settle(open, 0, { confirmed: [confirmedGroup] });

    for (let at = 5000; at <= 60000; at += 5000) {
      expect(settle(open, at, { comparable: false }).has(SIGNATURE)).toBe(true);
    }
    expect(settle(open, 65000).has(SIGNATURE)).toBe(true);
  });

  it('does not count a round where the divergence is being counted again as clean', () => {
    const open = new Map<string, OpenDivergence>();
    settle(open, 0, { confirmed: [confirmedGroup] });

    for (let at = 5000; at <= 30000; at += 5000) {
      expect(settle(open, at, { pendingSignatures: new Set([SIGNATURE]) }).has(SIGNATURE)).toBe(true);
    }
  });

  it('starts the clean count over when the divergence is being counted again', () => {
    const open = new Map<string, OpenDivergence>();
    const pending = { pendingSignatures: new Set([SIGNATURE]) };
    settle(open, 0, { confirmed: [confirmedGroup] });

    for (let at = 5000; at <= TOPOLOGY_DIVERGENCE_BLIND_MS; at += 10000) {
      expect(settle(open, at).has(SIGNATURE)).toBe(true);
      expect(settle(open, at + 5000, pending).has(SIGNATURE)).toBe(true);
    }
    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS + 5000, pending).has(SIGNATURE)).toBe(true);
  });

  it('keeps an event open past the blind limit while compared rounds still count the divergence', () => {
    const open = new Map<string, OpenDivergence>();
    const pending = { pendingSignatures: new Set([SIGNATURE]) };
    settle(open, 0, { confirmed: [confirmedGroup] });

    for (let at = 5000; at <= TOPOLOGY_DIVERGENCE_BLIND_MS + 60000; at += 5000) {
      expect(settle(open, at, pending).has(SIGNATURE)).toBe(true);
    }
    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS + 65000).has(SIGNATURE)).toBe(true);
    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS + 70000).has(SIGNATURE)).toBe(true);
    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS + 75000).has(SIGNATURE)).toBe(false);
  });

  it('measures the blind limit from the last compared round that counted the divergence', () => {
    const open = new Map<string, OpenDivergence>();
    const pending = { pendingSignatures: new Set([SIGNATURE]) };
    const lastCounted = TOPOLOGY_DIVERGENCE_BLIND_MS + 60000;
    settle(open, 0, { confirmed: [confirmedGroup] });
    for (let at = 5000; at <= lastCounted; at += 5000) settle(open, at, pending);

    const blind = { comparable: false };
    expect(settle(open, lastCounted + 5000, blind).has(SIGNATURE)).toBe(true);
    expect(settle(open, lastCounted + TOPOLOGY_DIVERGENCE_BLIND_MS, blind).has(SIGNATURE)).toBe(true);
    expect(settle(open, lastCounted + TOPOLOGY_DIVERGENCE_BLIND_MS + 1, blind).has(SIGNATURE)).toBe(false);
  });

  it('holds the blind limit for a divergence still counted in rounds it could not compare', () => {
    const open = new Map<string, OpenDivergence>();
    const blind = { comparable: false, pendingSignatures: new Set([SIGNATURE]) };
    settle(open, 0, { confirmed: [confirmedGroup] });

    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS, blind).has(SIGNATURE)).toBe(true);
    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS + 1, blind).has(SIGNATURE)).toBe(false);
  });

  it('keeps the clean count through a round it could not compare', () => {
    const open = new Map<string, OpenDivergence>();
    settle(open, 0, { confirmed: [confirmedGroup] });

    expect(settle(open, 5000).has(SIGNATURE)).toBe(true);
    expect(settle(open, 10000, { comparable: false }).has(SIGNATURE)).toBe(true);
    expect(settle(open, 15000).has(SIGNATURE)).toBe(true);
    expect(settle(open, 20000, { comparable: false }).has(SIGNATURE)).toBe(true);
    expect(settle(open, 25000).has(SIGNATURE)).toBe(false);
  });

  it('lets go of an event it could not confirm again within the blind limit', () => {
    const open = new Map<string, OpenDivergence>();
    settle(open, 0, { confirmed: [confirmedGroup] });

    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS, { comparable: false }).has(SIGNATURE)).toBe(true);
    expect(settle(open, TOPOLOGY_DIVERGENCE_BLIND_MS + 1, { comparable: false }).has(SIGNATURE)).toBe(false);
  });

  it('gives an event it did not raise itself the same rounds to be confirmed', () => {
    const open = new Map<string, OpenDivergence>();

    expect(settle(open, 0).has(SIGNATURE)).toBe(true);
    expect(settle(open, 5000).has(SIGNATURE)).toBe(true);
    expect(settle(open, 10000).has(SIGNATURE)).toBe(false);
  });

  it('forgets an event that is no longer open', () => {
    const open = new Map<string, OpenDivergence>();
    settle(open, 0, { confirmed: [confirmedGroup] });
    settle(open, 5000, { openSignatures: [] });

    expect(open.size).toBe(0);
  });
});
