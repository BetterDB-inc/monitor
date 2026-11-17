import type { ClusterNode } from '@app/common/types/metrics.types';
import { DivergenceTracker, compareTopologyViews, type TrackedDisagreement } from '../topology-divergence';
import type { FailureFlagViews } from '../topology-divergence-monitor';
import {
  DISAGREEMENT_LIST_LIMIT,
  type DisagreementRound,
  summarizeDisagreements,
  withDisputedShardsOnly,
} from '../topology-disagreements';
import { AnomalySeverity, MetricType } from '../types';

const AT = 1_000_000;
const SLOTS = 16384;

function node(id: string, patch: Partial<ClusterNode> = {}): ClusterNode {
  return {
    id,
    address: `${id}.internal:6379@16379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [],
    ...patch,
  };
}

function cluster(shards: number, replicas = 1, zones = ['a', 'b', 'c']): ClusterNode[] {
  const width = Math.floor(SLOTS / shards);
  const nodes: ClusterNode[] = [];
  for (let shard = 0; shard < shards; shard++) {
    const shardId = `s${String(shard).padStart(3, '0')}`;
    const end = shard === shards - 1 ? SLOTS - 1 : (shard + 1) * width - 1;
    const primary = `${shardId}p`;
    nodes.push(node(primary, { slots: [[shard * width, end]], shardId, availabilityZone: zones[shard % zones.length] }));
    for (let replica = 0; replica < replicas; replica++) {
      nodes.push(
        node(`${shardId}r${replica}`, {
          flags: ['slave'],
          master: primary,
          shardId,
          availabilityZone: zones[(shard + replica + 1) % zones.length],
        }),
      );
    }
  }
  return nodes;
}

function tracked(patch: Partial<TrackedDisagreement> & Pick<TrackedDisagreement, 'key' | 'kind' | 'positions'>): TrackedDisagreement {
  return { subjectIds: [], firstSeenAt: AT - 10_000, lastSeenAt: AT, rounds: 3, ...patch };
}

function round(nodes: ClusterNode[], patch: Partial<DisagreementRound> = {}): DisagreementRound {
  return {
    status: 'ok',
    at: AT,
    observers: [],
    unanswered: [],
    disagreements: [],
    nodes: new Map(nodes.map((entry) => [entry.id, entry])),
    failureFlags: new Map<string, FailureFlagViews>(),
    ...patch,
  };
}

const noEvent = () => undefined;

describe('summarizeDisagreements', () => {
  it('says not sampled when there is no round', () => {
    expect(summarizeDisagreements(undefined, noEvent)).toEqual({
      status: 'not_sampled',
      sampledAt: null,
      coverage: { nodes: 0, asked: 0, answered: 0, complete: false, unanswered: [], unansweredCount: 0 },
      disagreements: [],
      shards: [],
      shardTotals: { total: 0, disputed: 0, undisputed: 0, notCompared: 0 },
      shardsListed: 'all',
    });
  });

  it('gives one line per shard when the views agree', () => {
    const summary = summarizeDisagreements(round(cluster(3), { observers: ['s000p', 's001p', 's001r0'] }), noEvent);

    expect(summary.disagreements).toEqual([]);
    expect(summary.shards).toEqual([
      {
        shardId: 's000',
        primary: { nodeId: 's000p', address: 's000p.internal:6379', role: 'primary', shardId: 's000', availabilityZone: 'a' },
        replicas: 1,
        zones: ['a', 'b'],
        slots: [[0, 5460]],
        slotCount: 5461,
        nodes: 2,
        ownViews: 1,
        state: 'undisputed',
        disagreementIds: [],
        staleDisagreementIds: [],
      },
      expect.objectContaining({ shardId: 's001', slots: [[5461, 10921]], ownViews: 2, state: 'undisputed' }),
      expect.objectContaining({ shardId: 's002', slots: [[10922, 16383]], ownViews: 0, state: 'undisputed' }),
    ]);
  });

  it('reports how much of the cluster was asked', () => {
    const summary = summarizeDisagreements(
      round(cluster(3), { observers: ['s000p', 's001p', 's002p'], unanswered: ['s002p'] }),
      noEvent,
    );

    expect(summary.status).toBe('ok');
    expect(summary.sampledAt).toBe(AT);
    expect(summary.coverage).toEqual({
      nodes: 6,
      asked: 3,
      answered: 2,
      complete: false,
      unanswered: [expect.objectContaining({ nodeId: 's002p', address: 's002p.internal:6379' })],
      unansweredCount: 1,
    });
    expect(summary.shards.find((shard) => shard.shardId === 's002')?.ownViews).toBe(0);
  });

  it('is complete only when every member gave a view', () => {
    const nodes = cluster(2);
    const everyone = nodes.map((entry) => entry.id);

    expect(summarizeDisagreements(round(nodes, { observers: everyone }), noEvent).coverage.complete).toBe(true);
    expect(
      summarizeDisagreements(round(nodes, { observers: everyone, unanswered: ['s001r0'] }), noEvent).coverage.complete,
    ).toBe(false);
  });

  it('does not count entries in handshake or without an address as members', () => {
    const nodes = [
      ...cluster(1),
      node('ghost', { flags: ['master', 'noaddr'] }),
      node('newcomer', { flags: ['handshake'] }),
    ];

    const summary = summarizeDisagreements(round(nodes, { observers: ['s000p', 's000r0'] }), noEvent);

    expect(summary.coverage.nodes).toBe(2);
    expect(summary.coverage.complete).toBe(true);
    expect(summary.shards.map((shard) => shard.shardId)).toEqual(['s000']);
  });

  it('marks the shards as not compared when only one view was read', () => {
    const summary = summarizeDisagreements(
      round(cluster(2), { status: 'insufficient_views', observers: ['s000p'] }),
      noEvent,
    );

    expect(summary.status).toBe('insufficient_views');
    expect(summary.shards.map((shard) => shard.state)).toEqual(['not_compared', 'not_compared']);
  });

  describe('a disagreement that was not seen in the last round', () => {
    const fresh = tracked({
      key: 'failure_flags:s001r0',
      kind: 'failure_flags',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'failing', observers: ['s000p'] },
        { value: 'ok', observers: ['s001p'] },
      ],
    });
    const old = tracked({
      key: 'slot_owner:s000p|s002p',
      kind: 'slot_owner',
      subjectIds: ['s000p', 's002p'],
      slots: [[0, 9]],
      lastSeenAt: AT - 60_000,
      positions: [
        { value: 's000p', observers: ['s000p', 's000r0'] },
        { value: 's002p', observers: ['s002p'] },
      ],
    });
    const eventOf = (key: string) =>
      key === old.key ? { eventId: 'e3', eventType: MetricType.TOPOLOGY_DIVERGENCE, eventAt: AT, connectionId: 'c1' } : undefined;

    it('is kept without counts, after the lines of this round, and says when it was last seen', () => {
      const summary = summarizeDisagreements(
        round(cluster(3), { observers: ['s000p', 's000r0', 's001p'], disagreements: [fresh, old] }),
        eventOf,
      );

      expect(summary.disagreements.map((line) => [line.id, line.stale])).toEqual([
        ['failure_flags:s001r0', false],
        ['slot_owner:s000p|s002p', true],
      ]);
      expect(summary.disagreements[1]).toMatchObject({
        severity: AnomalySeverity.CRITICAL,
        confirmed: true,
        eventId: 'e3',
        since: AT - 10_000,
        lastSeenAt: AT - 60_000,
        positions: [],
        slots: [[0, 9]],
        slotCount: 10,
        shardIds: ['s000', 's002'],
        text: 'Slots 0-9: views differed on the owner (s000p.internal:6379, s002p.internal:6379).',
      });
    });

    it('does not make a shard disputed and leaves it as not compared', () => {
      const summary = summarizeDisagreements(
        round(cluster(3), { observers: ['s000p', 's000r0', 's001p'], disagreements: [fresh, old] }),
        noEvent,
      );

      expect(summary.shards.map((shard) => [shard.shardId, shard.state, shard.disagreementIds])).toEqual([
        ['s001', 'disputed', ['failure_flags:s001r0']],
        ['s000', 'not_compared', []],
        ['s002', 'not_compared', []],
      ]);
      expect(summary.shardTotals).toEqual({ total: 3, disputed: 1, undisputed: 0, notCompared: 2 });
    });

    it('names it on the shards it touches, apart from the lines of this round', () => {
      const summary = summarizeDisagreements(
        round(cluster(3), { observers: ['s000p', 's000r0', 's001p'], disagreements: [fresh, old] }),
        noEvent,
      );

      expect(summary.shards.map((shard) => [shard.shardId, shard.staleDisagreementIds])).toEqual([
        ['s001', []],
        ['s000', ['slot_owner:s000p|s002p']],
        ['s002', ['slot_owner:s000p|s002p']],
      ]);
    });

    it('lists the views it is waiting for as unanswered and counts only the views of this round as asked', () => {
      const summary = summarizeDisagreements(
        round(cluster(3), { observers: ['s000p', 's000r0', 's001p'], disagreements: [fresh, old] }),
        noEvent,
      );

      expect(summary.coverage).toMatchObject({ asked: 3, answered: 3, complete: false, unansweredCount: 1 });
      expect(summary.coverage.unanswered.map((entry) => entry.nodeId)).toEqual(['s002p']);
    });

    it('holds every line without counts in a round that could not compare', () => {
      const summary = summarizeDisagreements(
        round(cluster(3), {
          status: 'insufficient_views',
          observers: ['s000p'],
          disagreements: [fresh, old],
        }),
        noEvent,
      );

      expect(summary.disagreements.map((line) => [line.id, line.stale, line.positions])).toEqual([
        ['slot_owner:s000p|s002p', true, []],
        ['failure_flags:s001r0', true, []],
      ]);
      expect(summary.disagreements[1].text).toBe('s001r0.internal:6379: views differed on whether it is failing.');
      expect(summary.shards.map((shard) => [shard.state, shard.disagreementIds])).toEqual([
        ['not_compared', []],
        ['not_compared', []],
        ['not_compared', []],
      ]);
      expect(summary.shardTotals).toEqual({ total: 3, disputed: 0, undisputed: 0, notCompared: 3 });
    });

    it('merges with other lines last seen in the same round, never with a line of this round', () => {
      const about = (subject: string, lastSeenAt: number) =>
        tracked({
          key: `membership:${subject}`,
          kind: 'membership',
          subjectIds: [subject],
          lastSeenAt,
          positions: [
            { value: 'known', observers: ['s000p'] },
            { value: 'missing', observers: ['s000r0'] },
          ],
        });
      const disagreements = [
        about('s001p', AT),
        about('s001r0', AT - 5000),
        about('s002p', AT - 5000),
        about('s002r0', AT - 10_000),
      ];

      const summary = summarizeDisagreements(round(cluster(3), { disagreements }), noEvent);

      expect(summary.disagreements.map((line) => [line.id, line.stale, line.lastSeenAt, line.text])).toEqual([
        ['membership:s001p', false, AT, 's001p.internal:6379: a member in 1 view, not known in 1 view.'],
        ['membership:s001r0+1', true, AT - 5000, '2 nodes: views differed on whether they are members.'],
        [
          'membership:s002r0',
          true,
          AT - 10_000,
          's002r0.internal:6379: views differed on whether it is a member.',
        ],
      ]);
    });

    it('names no epoch for a config epoch it could not read again', () => {
      const epoch = tracked({
        key: 'config_epoch:s001p',
        kind: 'config_epoch',
        subjectIds: ['s001p'],
        lastSeenAt: AT - 5000,
        positions: [
          { value: '4', observers: ['s002p'] },
          { value: '7', observers: ['s000p'] },
        ],
      });

      const [line] = summarizeDisagreements(round(cluster(3), { disagreements: [epoch] }), noEvent).disagreements;

      expect(line.text).toBe('Config epoch of s001p.internal:6379: views differed.');
      expect(line.epochs).toBeUndefined();
    });
  });

  it('can leave out the shards that are not disputed and keeps their totals', () => {
    const flags = tracked({
      key: 'failure_flags:s001r0',
      kind: 'failure_flags',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'failing', observers: ['s000p'] },
        { value: 'ok', observers: ['s001p'] },
      ],
    });
    const summary = summarizeDisagreements(round(cluster(3), { disagreements: [flags] }), noEvent);

    const trimmed = withDisputedShardsOnly(summary);

    expect(summary.shardsListed).toBe('all');
    expect(trimmed.shardsListed).toBe('disputed');
    expect(trimmed.shards.map((shard) => shard.shardId)).toEqual(['s001']);
    expect(trimmed.shardTotals).toEqual({ total: 3, disputed: 1, undisputed: 2, notCompared: 0 });
    expect(trimmed.disagreements).toEqual(summary.disagreements);
  });

  it('counts both sides of a slot owner dispute and marks the shards it touches', () => {
    const dispute = tracked({
      key: 'slot_owner:s000p|s001p',
      kind: 'slot_owner',
      subjectIds: ['s000p', 's001p'],
      slots: [[0, 99]],
      positions: [
        { value: 's000p', observers: ['s000p', 's000r0', 's002p'] },
        { value: 's001p', observers: ['s001p'] },
      ],
    });

    const summary = summarizeDisagreements(
      round(cluster(3), { observers: ['s000p', 's000r0', 's001p', 's002p'], disagreements: [dispute] }),
      noEvent,
    );

    expect(summary.disagreements).toEqual([
      {
        id: 'slot_owner:s000p|s001p',
        kind: 'slot_owner',
        severity: AnomalySeverity.CRITICAL,
        confirmed: false,
        eventId: null,
        eventType: null,
        eventAt: null,
        eventConnectionId: null,
        tracked: true,
        since: AT - 10_000,
        rounds: 3,
        stale: false,
        lastSeenAt: AT,
        subjects: [expect.objectContaining({ nodeId: 's000p' }), expect.objectContaining({ nodeId: 's001p' })],
        subjectCount: 2,
        slots: [[0, 99]],
        slotCount: 100,
        shardIds: ['s000', 's001'],
        positions: [
          {
            value: 's000p',
            owner: expect.objectContaining({ nodeId: 's000p', address: 's000p.internal:6379' }),
            count: 3,
            observerCount: 3,
            observers: [
              expect.objectContaining({ nodeId: 's000p' }),
              expect.objectContaining({ nodeId: 's000r0' }),
              expect.objectContaining({ nodeId: 's002p' }),
            ],
          },
          {
            value: 's001p',
            owner: expect.objectContaining({ nodeId: 's001p' }),
            count: 1,
            observerCount: 1,
            observers: [expect.objectContaining({ nodeId: 's001p' })],
          },
        ],
        text: 'Slots 0-99: owned by s000p.internal:6379 in 3 views, by s001p.internal:6379 in 1 view.',
      },
    ]);
    expect(summary.shards.map((shard) => [shard.shardId, shard.state, shard.disagreementIds])).toEqual([
      ['s000', 'disputed', ['slot_owner:s000p|s001p']],
      ['s001', 'disputed', ['slot_owner:s000p|s001p']],
      ['s002', 'undisputed', []],
    ]);
  });

  it('marks a shard whose slots are disputed even when it is not one of the claimed owners', () => {
    const dispute = tracked({
      key: 'slot_owner:s001p|unassigned',
      kind: 'slot_owner',
      subjectIds: ['s001p'],
      slots: [[10, 10]],
      positions: [
        { value: 's001p', observers: ['s001p'] },
        { value: 'unassigned', observers: ['s002p', 's002r0'] },
      ],
    });

    const summary = summarizeDisagreements(round(cluster(3), { disagreements: [dispute] }), noEvent);

    expect(summary.disagreements[0].shardIds).toEqual(['s000', 's001']);
    expect(summary.disagreements[0].positions.map((position) => [position.value, position.owner])).toEqual([
      ['unassigned', undefined],
      ['s001p', expect.objectContaining({ nodeId: 's001p' })],
    ]);
    expect(summary.disagreements[0].text).toBe(
      'Slot 10: unassigned in 2 views, owned by s001p.internal:6379 in 1 view.',
    );
  });

  it('shortens a long list of slot ranges in the text', () => {
    const dispute = tracked({
      key: 'slot_owner:s000p|s001p',
      kind: 'slot_owner',
      subjectIds: ['s000p', 's001p'],
      slots: [[0, 1], [5, 6], [9, 9], [20, 30], [40, 41]],
      positions: [
        { value: 's000p', observers: ['s000p', 's002p'] },
        { value: 's001p', observers: ['s001p'] },
      ],
    });

    const [line] = summarizeDisagreements(round(cluster(3), { disagreements: [dispute] }), noEvent).disagreements;

    expect(line.slotCount).toBe(18);
    expect(line.text).toMatch(/^Slots 0-1, 5-6, 9 \+2 more ranges: /);
  });

  it('tells fail? from fail in a failure flag disagreement', () => {
    const flags = tracked({
      key: 'failure_flags:s001r0',
      kind: 'failure_flags',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'failing', observers: ['s000p', 's000r0', 's002p'] },
        { value: 'ok', observers: ['s001p', 's002r0'] },
      ],
    });

    const [line] = summarizeDisagreements(
      round(cluster(3), {
        disagreements: [flags],
        failureFlags: new Map([['s001r0', { suspected: ['s000p', 's002p'], failed: ['s000r0'] }]]),
      }),
      noEvent,
    ).disagreements;

    expect(line.severity).toBe(AnomalySeverity.WARNING);
    expect(line.shardIds).toEqual(['s001']);
    expect(line.positions.map((position) => [position.value, position.count])).toEqual([
      ['fail?', 2],
      ['ok', 2],
      ['fail', 1],
    ]);
    expect(line.text).toBe('s001r0.internal:6379: fail? in 2 views, ok in 2 views, fail in 1 view.');
  });

  it('keeps failing for a view whose flag was not recorded this round', () => {
    const flags = tracked({
      key: 'failure_flags:s001r0',
      kind: 'failure_flags',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'failing', observers: ['s000p'] },
        { value: 'ok', observers: ['s001p', 's002p'] },
      ],
    });

    const [line] = summarizeDisagreements(round(cluster(3), { disagreements: [flags] }), noEvent).disagreements;

    expect(line.positions.map((position) => [position.value, position.count])).toEqual([
      ['ok', 2],
      ['failing', 1],
    ]);
  });

  it('merges disagreements that differ only in the node they are about', () => {
    const subjects = ['s001p', 's001r0', 's002p'];
    const disagreements = subjects.map((subject, i) =>
      tracked({
        key: `failure_flags:${subject}`,
        kind: 'failure_flags',
        subjectIds: [subject],
        firstSeenAt: AT - 1000 * (i + 1),
        rounds: i + 2,
        positions: [
          { value: 'failing', observers: ['s000p'] },
          { value: 'ok', observers: ['s000r0', 's002r0'] },
        ],
      }),
    );
    const suspected = { suspected: ['s000p'], failed: [] };

    const summary = summarizeDisagreements(
      round(cluster(3), {
        disagreements,
        failureFlags: new Map(subjects.map((subject) => [subject, suspected])),
      }),
      noEvent,
    );

    expect(summary.disagreements).toHaveLength(1);
    expect(summary.disagreements[0]).toMatchObject({
      id: 'failure_flags:s001p+2',
      subjectCount: 3,
      since: AT - 3000,
      rounds: 4,
      shardIds: ['s001', 's002'],
      text: '3 nodes: ok in 2 views, fail? in 1 view.',
    });
    expect(summary.disagreements[0].subjects.map((subject) => subject.nodeId)).toEqual(subjects);
    expect(summary.shards.find((shard) => shard.shardId === 's002')?.disagreementIds).toEqual([
      'failure_flags:s001p+2',
    ]);
  });

  it('merges the nodes of a cut-off side that still vouch for each other', () => {
    const cutOff = ['s002p', 's002r0'];
    const disagreements = cutOff.map((subject) =>
      tracked({
        key: `failure_flags:${subject}`,
        kind: 'failure_flags',
        subjectIds: [subject],
        positions: [
          { value: 'failing', observers: ['s000p', 's000r0', 's001p'] },
          { value: 'ok', observers: cutOff.filter((id) => id !== subject) },
        ],
      }),
    );

    const summary = summarizeDisagreements(round(cluster(3), { disagreements }), noEvent);

    expect(summary.disagreements).toHaveLength(1);
    expect(
      summary.disagreements[0].positions.map((position) => [position.value, position.count, position.observerCount]),
    ).toEqual([
      ['failing', 3, 3],
      ['ok', 1, 2],
    ]);
    expect(
      summary.disagreements[0].positions.map((position) => position.observers.map((observer) => observer.nodeId)),
    ).toEqual([
      ['s000p', 's000r0', 's001p'],
      ['s002p', 's002r0'],
    ]);
  });

  it('never leaves a side that has views without a node to name', () => {
    const cutOff = cluster(6)
      .filter((entry) => entry.availabilityZone === 'b')
      .map((entry) => entry.id);
    const rest = cluster(6)
      .map((entry) => entry.id)
      .filter((id) => !cutOff.includes(id));
    const disagreements = cutOff.map((subject) =>
      tracked({
        key: `failure_flags:${subject}`,
        kind: 'failure_flags',
        subjectIds: [subject],
        positions: [
          { value: 'failing', observers: rest },
          { value: 'ok', observers: cutOff.filter((id) => id !== subject) },
        ],
      }),
    );

    const summary = summarizeDisagreements(round(cluster(6), { disagreements }), noEvent);

    expect(summary.disagreements).toHaveLength(1);
    for (const position of summary.disagreements[0].positions) {
      expect(position.count).toBeGreaterThan(0);
      expect(position.observers.length).toBeGreaterThan(0);
      expect(position.observerCount).toBeGreaterThanOrEqual(position.observers.length);
    }
    expect(summary.disagreements[0].positions[1]).toMatchObject({
      value: 'ok',
      count: cutOff.length - 1,
      observerCount: cutOff.length,
    });
  });

  it('lists on a merged line every view that holds the side for one of its nodes, and how many they are', () => {
    const about = (subject: string, vouching: string) =>
      tracked({
        key: `failure_flags:${subject}`,
        kind: 'failure_flags',
        subjectIds: [subject],
        positions: [
          { value: 'failing', observers: ['s000p'] },
          { value: 'ok', observers: ['s000r0', vouching].sort() },
        ],
      });
    const disagreements = [about('s001p', 's001r0'), about('s001r0', 's001p'), about('s002p', 's001p')];

    const [line, ...rest] = summarizeDisagreements(round(cluster(3), { disagreements }), noEvent).disagreements;

    expect(rest).toEqual([]);
    expect(
      line.positions.map((position) => [
        position.value,
        position.count,
        position.observerCount,
        position.observers.map((observer) => observer.nodeId),
      ]),
    ).toEqual([
      ['ok', 2, 3, ['s000r0', 's001p', 's001r0']],
      ['failing', 1, 1, ['s000p']],
    ]);
  });

  it('keeps disagreements apart when the counts differ', () => {
    const about = (subject: string, ok: string[]) =>
      tracked({
        key: `failure_flags:${subject}`,
        kind: 'failure_flags',
        subjectIds: [subject],
        positions: [
          { value: 'failing', observers: ['s000p'] },
          { value: 'ok', observers: ok },
        ],
      });

    const summary = summarizeDisagreements(
      round(cluster(3), { disagreements: [about('s001p', ['s002p', 's002r0']), about('s002p', ['s002r0'])] }),
      noEvent,
    );

    expect(summary.disagreements.map((line) => line.id)).toEqual(['failure_flags:s001p', 'failure_flags:s002p']);
  });

  it('keeps disagreements apart when the sides or the event differ', () => {
    const about = (subject: string, failing: string[]) =>
      tracked({
        key: `failure_flags:${subject}`,
        kind: 'failure_flags',
        subjectIds: [subject],
        positions: [
          { value: 'failing', observers: failing },
          { value: 'ok', observers: ['s002r0'] },
        ],
      });
    const disagreements = [about('s001p', ['s000p']), about('s001r0', ['s000r0']), about('s002p', ['s000p'])];
    const eventOf = (key: string) =>
      key === 'failure_flags:s002p' ? { eventId: 'e1', eventType: MetricType.TOPOLOGY_DIVERGENCE, eventAt: AT, connectionId: 'c1' } : undefined;

    const summary = summarizeDisagreements(round(cluster(3), { disagreements }), eventOf);

    expect(summary.disagreements.map((line) => [line.id, line.eventId])).toEqual([
      ['failure_flags:s002p', 'e1'],
      ['failure_flags:s001p', null],
      ['failure_flags:s001r0', null],
    ]);
  });

  it('names the membership states', () => {
    const membership = tracked({
      key: 'membership:s001r0',
      kind: 'membership',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'handshake', observers: ['s002r0'] },
        { value: 'known', observers: ['s000p', 's000r0', 's001p'] },
        { value: 'missing', observers: ['s002p'] },
        { value: 'noaddr', observers: ['s001r0'] },
      ],
    });

    const [line] = summarizeDisagreements(round(cluster(3), { disagreements: [membership] }), noEvent).disagreements;

    expect(line.text).toBe(
      's001r0.internal:6379: a member in 3 views, in handshake in 1 view, not known in 1 view, without an address in 1 view.',
    );
  });

  it('shows the epochs of one node and only the sides when several nodes are merged', () => {
    const epoch = (subject: string, low: string, high: string) =>
      tracked({
        key: `config_epoch:${subject}`,
        kind: 'config_epoch',
        subjectIds: [subject],
        positions: [
          { value: low, observers: ['s002p'] },
          { value: high, observers: ['s000p', 's000r0'] },
        ],
      });

    const [single] = summarizeDisagreements(
      round(cluster(3), { disagreements: [epoch('s001p', '4', '7')] }),
      noEvent,
    ).disagreements;
    const [merged] = summarizeDisagreements(
      round(cluster(3), { disagreements: [epoch('s001p', '4', '7'), epoch('s001r0', '2', '9')] }),
      noEvent,
    ).disagreements;

    expect(single.text).toBe('Config epoch of s001p.internal:6379: 7 in 2 views, 4 in 1 view.');
    expect(single.epochs).toBeUndefined();
    expect(merged.text).toBe('Config epoch of 2 nodes: 2 views against 1 view.');
    expect(merged.positions.map((position) => [position.value, position.count])).toEqual([
      [null, 2],
      [null, 1],
    ]);
    expect(merged.epochs).toEqual([
      { node: expect.objectContaining({ nodeId: 's001p' }), values: ['7', '4'] },
      { node: expect.objectContaining({ nodeId: 's001r0' }), values: ['9', '2'] },
    ]);
  });

  it('keeps both epochs of every node when the merged sides are of the same size', () => {
    const epoch = (subject: string, sides: Array<[string, string]>) =>
      tracked({
        key: `config_epoch:${subject}`,
        kind: 'config_epoch',
        subjectIds: [subject],
        positions: sides.map(([value, observer]) => ({ value, observers: [observer] })),
      });
    const disagreements = [
      epoch('s000p', [['7', 's001p'], ['4', 's002p']]),
      epoch('s001p', [['9', 's000p'], ['2', 's002p']]),
      epoch('s002p', [['5', 's000p'], ['3', 's001p']]),
    ];

    const [merged, ...rest] = summarizeDisagreements(round(cluster(3), { disagreements }), noEvent).disagreements;

    expect(rest).toEqual([]);
    expect(merged.text).toBe('Config epoch of 3 nodes: 1 view against 1 view.');
    expect(merged.epochs?.map((entry) => [entry.node.nodeId, entry.values])).toEqual([
      ['s000p', ['4', '7']],
      ['s001p', ['2', '9']],
      ['s002p', ['3', '5']],
    ]);
    expect(
      merged.positions.map((position) => [position.count, position.observerCount, position.observers.map((n) => n.nodeId)]),
    ).toEqual([
      [1, 2, ['s001p', 's002p']],
      [1, 2, ['s000p', 's001p']],
    ]);
  });

  it('keeps each epoch of a merged line in the column of the view that reported it', () => {
    const epoch = (subject: string, sides: Array<[string, string]>) =>
      tracked({
        key: `config_epoch:${subject}`,
        kind: 'config_epoch',
        subjectIds: [subject],
        positions: sides.map(([value, observer]) => ({ value, observers: [observer] })),
      });
    const disagreements = [
      epoch('s000p', [['4', 's002p'], ['7', 's000p']]),
      epoch('s002p', [['3', 's000p'], ['8', 's002p']]),
    ];

    const [merged, ...rest] = summarizeDisagreements(round(cluster(3), { disagreements }), noEvent).disagreements;

    expect(rest).toEqual([]);
    expect(merged.positions.map((position) => position.observers.map((node) => node.nodeId))).toEqual([
      ['s002p'],
      ['s000p'],
    ]);
    expect(merged.epochs?.map((entry) => [entry.node.nodeId, entry.values])).toEqual([
      ['s000p', ['4', '7']],
      ['s002p', ['8', '3']],
    ]);
  });

  it('links a disagreement to the event that holds it', () => {
    const membership = tracked({
      key: 'membership:s001r0',
      kind: 'membership',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'known', observers: ['s000p'] },
        { value: 'missing', observers: ['s002p'] },
      ],
    });
    const eventOf = jest.fn().mockReturnValue({
      eventId: 'e7',
      eventType: MetricType.TOPOLOGY_DIVERGENCE,
      eventAt: AT - 40_000,
      connectionId: 'c1',
    });

    const [line] = summarizeDisagreements(round(cluster(3), { disagreements: [membership] }), eventOf).disagreements;

    expect(eventOf).toHaveBeenCalledWith('membership:s001r0');
    expect(line).toMatchObject({
      confirmed: true,
      eventId: 'e7',
      eventType: MetricType.TOPOLOGY_DIVERGENCE,
      eventAt: AT - 40_000,
      eventConnectionId: 'c1',
    });
  });

  it('marks the lines of a tracked round as tracked, with their age', () => {
    const membership = tracked({
      key: 'membership:s001r0',
      kind: 'membership',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'known', observers: ['s000p'] },
        { value: 'missing', observers: ['s002p'] },
      ],
    });

    const [line] = summarizeDisagreements(round(cluster(3), { disagreements: [membership] }), noEvent).disagreements;

    expect(line).toMatchObject({ tracked: true, since: AT - 10_000, rounds: 3 });
  });

  it('gives the lines of a one-off round no age and no round count', () => {
    const { firstSeenAt: _firstSeenAt, lastSeenAt: _lastSeenAt, rounds: _rounds, ...membership } = tracked({
      key: 'membership:s001r0',
      kind: 'membership',
      subjectIds: ['s001r0'],
      positions: [
        { value: 'known', observers: ['s000p'] },
        { value: 'missing', observers: ['s002p'] },
      ],
    });
    const eventOf = jest.fn().mockReturnValue({
      eventId: 'e7',
      eventType: MetricType.TOPOLOGY_DIVERGENCE,
      eventAt: AT,
      connectionId: 'c1',
    });

    const [line] = summarizeDisagreements(round(cluster(3), { disagreements: [membership] }), eventOf).disagreements;

    expect(line.tracked).toBe(false);
    expect(line).not.toHaveProperty('since');
    expect(line).not.toHaveProperty('rounds');
    expect(line).toMatchObject({ confirmed: true, eventId: 'e7' });
  });

  it('orders the lines of a one-off round by severity, then event, then id', () => {
    const untracked = (key: string, kind: 'membership' | 'slot_owner') => ({
      key,
      kind,
      subjectIds: kind === 'membership' ? [key.split(':')[1]] : ['s000p', 's001p'],
      ...(kind === 'slot_owner' ? { slots: [[5, 5]] } : {}),
      positions: [
        { value: kind === 'membership' ? 'known' : 's000p', observers: ['s000p'] },
        { value: kind === 'membership' ? 'missing' : 's001p', observers: [`${key}-observer`] },
      ],
    });
    const eventOf = (key: string) =>
      key === 'membership:s002r0'
        ? { eventId: 'e1', eventType: MetricType.TOPOLOGY_DIVERGENCE, eventAt: AT, connectionId: 'c1' }
        : undefined;

    const summary = summarizeDisagreements(
      round(cluster(3), {
        disagreements: [
          untracked('membership:s001r0', 'membership'),
          untracked('membership:s002r0', 'membership'),
          untracked('slot_owner:s000p|s001p#0', 'slot_owner'),
        ],
      }),
      eventOf,
    );

    expect(summary.disagreements.map((line) => line.id)).toEqual([
      'slot_owner:s000p|s001p#0',
      'membership:s002r0',
      'membership:s001r0',
    ]);
  });

  it('puts critical first, then confirmed, then the oldest', () => {
    const flags = (subject: string, firstSeenAt: number, failing: string) =>
      tracked({
        key: `failure_flags:${subject}`,
        kind: 'failure_flags',
        subjectIds: [subject],
        firstSeenAt,
        positions: [
          { value: 'failing', observers: [failing] },
          { value: 'ok', observers: ['s002r0'] },
        ],
      });
    const dispute = tracked({
      key: 'slot_owner:s000p|s001p',
      kind: 'slot_owner',
      subjectIds: ['s000p', 's001p'],
      slots: [[0, 0]],
      firstSeenAt: AT,
      positions: [
        { value: 's000p', observers: ['s000p'] },
        { value: 's001p', observers: ['s001p'] },
      ],
    });
    const eventOf = (key: string) =>
      key === 'failure_flags:s002p' ? { eventId: 'e1', eventType: MetricType.TOPOLOGY_DIVERGENCE, eventAt: AT, connectionId: 'c1' } : undefined;

    const summary = summarizeDisagreements(
      round(cluster(3), {
        disagreements: [
          flags('s001p', AT - 500, 's000p'),
          flags('s001r0', AT - 900, 's000r0'),
          flags('s002p', AT - 100, 's001p'),
          dispute,
        ],
      }),
      eventOf,
    );

    expect(summary.disagreements.map((line) => line.id)).toEqual([
      'slot_owner:s000p|s001p',
      'failure_flags:s002p',
      'failure_flags:s001r0',
      'failure_flags:s001p',
    ]);
  });

  it('lists disputed shards first, then by slot, with slotless shards last', () => {
    const nodes = [...cluster(3), node('empty', { shardId: 'aaa' })];
    const flags = tracked({
      key: 'failure_flags:s002r0',
      kind: 'failure_flags',
      subjectIds: ['s002r0'],
      positions: [
        { value: 'failing', observers: ['s000p'] },
        { value: 'ok', observers: ['s001p'] },
      ],
    });

    const summary = summarizeDisagreements(round(nodes, { disagreements: [flags] }), noEvent);

    expect(summary.shards.map((shard) => shard.shardId)).toEqual(['s002', 's000', 's001', 'aaa']);
  });

  it('groups nodes by their primary when shard ids are not known', () => {
    const nodes: ClusterNode[] = cluster(2).map(({ shardId: _shardId, ...rest }) => rest);
    nodes[0].shardId = 's000';

    const summary = summarizeDisagreements(round(nodes), noEvent);

    expect(summary.shards.map((shard) => [shard.shardId, shard.nodes, shard.primary?.nodeId])).toEqual([
      ['s000', 2, 's000p'],
      ['s001p', 2, 's001p'],
    ]);
  });

  it('keeps the replicas of a primary that no view lists in one shard', () => {
    const nodes = [
      node('p1', { slots: [[0, SLOTS - 1]] }),
      node('r1', { flags: ['slave'], master: 'gone' }),
      node('r2', { flags: ['slave'], master: 'gone' }),
      node('r3', { flags: ['slave'], master: '-' }),
    ];

    const summary = summarizeDisagreements(round(nodes), noEvent);

    expect(summary.shards.map((shard) => [shard.shardId, shard.nodes, shard.primary])).toEqual([
      ['p1', 1, expect.objectContaining({ nodeId: 'p1' })],
      ['gone', 2, null],
      ['r3', 1, null],
    ]);
    expect(summary.shardTotals.total).toBe(3);
  });

  it('caps the listed nodes and keeps the exact counts', () => {
    const nodes = cluster(40);
    const primaries = nodes.filter((entry) => entry.flags.includes('master')).map((entry) => entry.id);
    const replicas = nodes.filter((entry) => !entry.flags.includes('master')).map((entry) => entry.id);
    const disagreements = primaries.slice(0, 30).map((subject) =>
      tracked({
        key: `membership:${subject}`,
        kind: 'membership',
        subjectIds: [subject],
        positions: [
          { value: 'known', observers: replicas.slice(0, 30) },
          { value: 'missing', observers: replicas.slice(30) },
        ],
      }),
    );

    const summary = summarizeDisagreements(
      round(nodes, { observers: nodes.map((entry) => entry.id), unanswered: primaries, disagreements }),
      noEvent,
    );
    const [line] = summary.disagreements;

    expect(DISAGREEMENT_LIST_LIMIT).toBe(25);
    expect(line.subjectCount).toBe(30);
    expect(line.subjects).toHaveLength(25);
    expect(
      line.positions.map((position) => [position.count, position.observerCount, position.observers.length]),
    ).toEqual([
      [30, 30, 25],
      [10, 10, 10],
    ]);
    expect(summary.coverage.unansweredCount).toBe(40);
    expect(summary.coverage.unanswered).toHaveLength(25);
  });

  describe('at 500 nodes', () => {
    const nodes = cluster(250);
    const ids = nodes.map((entry) => entry.id);
    const cutOff = new Set(ids.filter((id) => nodes.find((entry) => entry.id === id)?.availabilityZone === 'c').slice(0, 3));
    const suspects = ['s010p', 's010r0', 's011p', 's011r0'];

    function viewsOf(observers: string[]) {
      return observers.map((observerId) => ({
        observerId,
        nodes: nodes.map((entry) => {
          const isolated = cutOff.has(observerId);
          const flags = entry.id === observerId ? ['myself', ...entry.flags] : [...entry.flags];
          if (isolated && suspects.includes(entry.id)) flags.push('fail?');
          if (isolated && entry.id === 's000p') return { ...entry, flags, slots: [[10, 64]] };
          if (isolated && entry.id === 's001p') return { ...entry, flags, slots: [[0, 9], ...entry.slots] };
          return { ...entry, flags };
        }),
      }));
    }

    function roundOf(observers: string[]): DisagreementRound {
      const views = viewsOf(observers);
      const tracker = new DivergenceTracker();
      tracker.observe({ at: AT, disagreements: compareTopologyViews(views), unanswered: [], views: views.length });
      const failureFlags = new Map<string, FailureFlagViews>(
        suspects.map((id) => [id, { suspected: observers.filter((observer) => cutOff.has(observer)), failed: [] }]),
      );
      return round(nodes, { observers, disagreements: tracker.tracked(), failureFlags });
    }

    it('summarises a round in which every node answered within the size budget', () => {
      const summary = summarizeDisagreements(roundOf(ids), noEvent);

      expect(JSON.stringify(summary).length).toBeLessThan(150_000);
      expect(JSON.stringify(withDisputedShardsOnly(summary)).length).toBeLessThan(20_000);
      expect(summary.coverage).toMatchObject({ nodes: 500, asked: 500, answered: 500, complete: true });
      expect(summary.shards).toHaveLength(250);
      expect(summary.shards.filter((shard) => shard.state === 'disputed').map((shard) => shard.shardId)).toEqual([
        's000',
        's001',
        's010',
        's011',
      ]);
      expect(summary.disagreements.map((line) => [line.kind, line.subjectCount])).toEqual([
        ['slot_owner', 2],
        ['failure_flags', 4],
      ]);
      expect(summary.disagreements[1].text).toBe('4 nodes: ok in 496 views, fail? in 3 views.');
      expect(summary.disagreements[0].positions.map((position) => position.count)).toEqual([497, 3]);
    });

    it('summarises a sampled round of 12 views the same way', () => {
      const observers = [...cutOff, ...ids.filter((id) => !cutOff.has(id)).slice(0, 9)];

      const summary = summarizeDisagreements(roundOf(observers), noEvent);

      expect(summary.coverage).toMatchObject({ nodes: 500, asked: 12, answered: 12, complete: false });
      expect(summary.disagreements.map((line) => line.positions.map((position) => position.count))).toEqual([
        [9, 3],
        [9, 3],
      ]);
      expect(summary.shards.filter((shard) => shard.ownViews > 0).length).toBeLessThanOrEqual(12);
    });
  });
});
