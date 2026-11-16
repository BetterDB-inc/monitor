import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  UNASSIGNED_SLOT_OWNER,
  intersectSlotRanges,
  type DivergenceKind,
  type DivergencePosition,
  type TrackedDisagreement,
} from './topology-divergence';
import type { FailureFlagViews } from './topology-divergence-monitor';
import { DIVERGENCE_SEVERITY_BY_KIND, toDivergenceNode, type DivergenceNode } from './topology-divergence-report';
import { AnomalySeverity, MetricType } from './types';

export const DISAGREEMENT_LIST_LIMIT = 25;

const MAX_LISTED_RANGES = 3;
const SHORT_ID_LENGTH = 8;
const NON_MEMBER_FLAGS = ['handshake', 'noaddr'];
const SEVERITY_RANK = [AnomalySeverity.INFO, AnomalySeverity.WARNING, AnomalySeverity.CRITICAL];
const MEMBERSHIP_LABELS: Record<string, string> = {
  known: 'a member',
  handshake: 'in handshake',
  noaddr: 'without an address',
  missing: 'not known',
};

export interface DisagreementEvent {
  eventId: string;
  eventType: MetricType;
}

export interface DisagreementRound {
  status: 'ok' | 'insufficient_views';
  at: number;
  observers: string[];
  unanswered: string[];
  disagreements: TrackedDisagreement[];
  nodes: ReadonlyMap<string, ClusterNode>;
  failureFlags: ReadonlyMap<string, FailureFlagViews>;
}

export interface DisagreementCoverage {
  nodes: number;
  asked: number;
  answered: number;
  complete: boolean;
  unanswered: DivergenceNode[];
  unansweredCount: number;
}

export interface DisagreementPosition {
  value: string | null;
  owner?: DivergenceNode;
  count: number;
  observers: DivergenceNode[];
}

export interface DisagreementLine {
  id: string;
  kind: DivergenceKind;
  severity: AnomalySeverity;
  confirmed: boolean;
  eventId: string | null;
  eventType: MetricType | null;
  since: number;
  rounds: number;
  stale: boolean;
  lastSeenAt: number;
  subjects: DivergenceNode[];
  subjectCount: number;
  slots?: number[][];
  slotCount?: number;
  shardIds: string[];
  positions: DisagreementPosition[];
  epochs?: Array<{ node: DivergenceNode; values: string[] }>;
  text: string;
}

export interface ShardLine {
  shardId: string;
  primary: DivergenceNode | null;
  replicas: number;
  zones: string[];
  slots: number[][];
  slotCount: number;
  nodes: number;
  ownViews: number;
  state: 'disputed' | 'undisputed' | 'not_compared';
  disagreementIds: string[];
}

export interface ShardTotals {
  total: number;
  disputed: number;
  undisputed: number;
  notCompared: number;
}

export interface TopologyDisagreementSummary {
  status: 'ok' | 'insufficient_views' | 'not_sampled';
  sampledAt: number | null;
  coverage: DisagreementCoverage;
  disagreements: DisagreementLine[];
  shards: ShardLine[];
  shardTotals: ShardTotals;
  shardsListed: 'all' | 'disputed';
}

interface Draft {
  disagreement: TrackedDisagreement;
  positions: DivergencePosition[];
  event: DisagreementEvent | undefined;
  stale: boolean;
}

interface Shard {
  shardId: string;
  members: ClusterNode[];
  slots: number[][];
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isPrimary(node: ClusterNode): boolean {
  return node.flags.includes('master');
}

function isMember(node: ClusterNode): boolean {
  return !node.flags.some((flag) => NON_MEMBER_FLAGS.includes(flag));
}

function rangesOf(slots: number[][]): number[][] {
  return slots.map(([start, end = start]) => [start, end]).sort((a, b) => a[0] - b[0]);
}

function countSlots(ranges: number[][]): number {
  return ranges.reduce((total, [start, end]) => total + end - start + 1, 0);
}

function viewsOf(count: number): string {
  return `${count} ${count === 1 ? 'view' : 'views'}`;
}

function shardKeyOf(node: ClusterNode, nodes: ReadonlyMap<string, ClusterNode>): string {
  if (node.shardId) return node.shardId;
  const primary = isPrimary(node) ? node : nodes.get(node.master);
  return primary?.shardId ?? primary?.id ?? node.id;
}

function shardsOf(members: ClusterNode[], nodes: ReadonlyMap<string, ClusterNode>): Shard[] {
  const byKey = new Map<string, ClusterNode[]>();
  for (const member of members) {
    const key = shardKeyOf(member, nodes);
    const group = byKey.get(key);
    if (group) group.push(member);
    else byKey.set(key, [member]);
  }
  return [...byKey.entries()].map(([shardId, group]) => ({
    shardId,
    members: group,
    slots: rangesOf(primaryOf(group)?.slots ?? []),
  }));
}

function primaryOf(members: ClusterNode[]): ClusterNode | undefined {
  const primaries = members.filter(isPrimary);
  return primaries.find((node) => node.slots.length > 0) ?? primaries[0];
}

function splitFailing(
  disagreement: TrackedDisagreement,
  failureFlags: ReadonlyMap<string, FailureFlagViews>,
): DivergencePosition[] {
  if (disagreement.kind !== 'failure_flags') return disagreement.positions;
  const flags = failureFlags.get(disagreement.subjectIds[0]);
  const suspected = new Set(flags?.suspected);
  const failed = new Set(flags?.failed);
  return disagreement.positions.flatMap((position) => {
    if (position.value !== 'failing') return [position];
    return [
      { value: 'fail?', observers: position.observers.filter((id) => suspected.has(id)) },
      { value: 'fail', observers: position.observers.filter((id) => failed.has(id)) },
      { value: 'failing', observers: position.observers.filter((id) => !suspected.has(id) && !failed.has(id)) },
    ].filter((split) => split.observers.length > 0);
  });
}

function sideOf(kind: DivergenceKind, position: DivergencePosition, subjects: ReadonlySet<string>): string {
  const value = kind === 'config_epoch' ? '' : position.value;
  const others = position.observers.filter((id) => !subjects.has(id));
  return `${value}#${position.observers.length}#${others.join(',')}`;
}

function mergeDrafts(drafts: Draft[]): Draft[][] {
  const subjectsByKind = new Map<DivergenceKind, Set<string>>();
  for (const { disagreement } of drafts) {
    const subjects = subjectsByKind.get(disagreement.kind) ?? new Set<string>();
    disagreement.subjectIds.forEach((id) => subjects.add(id));
    subjectsByKind.set(disagreement.kind, subjects);
  }

  const groups = new Map<string, Draft[]>();
  for (const draft of drafts) {
    const { kind, key } = draft.disagreement;
    const subjects = subjectsByKind.get(kind) as Set<string>;
    const sided = draft.positions
      .map((position) => ({ position, side: sideOf(kind, position, subjects), holders: position.observers.join(',') }))
      .sort(
        (x, y) =>
          compareText(x.side, y.side) ||
          compareText(x.holders, y.holders) ||
          compareText(x.position.value, y.position.value),
      );
    const sides = sided.map(({ side }) => side).join(';');
    const seen = draft.stale ? draft.disagreement.lastSeenAt : '';
    const signature = kind === 'slot_owner' ? key : `${kind}|${seen}|${draft.event?.eventId ?? ''}|${sides}`;
    const aligned = { ...draft, positions: sided.map(({ position }) => position) };
    const group = groups.get(signature);
    if (group) group.push(aligned);
    else groups.set(signature, [aligned]);
  }
  return [...groups.values()];
}

function heldByAll(sides: DivergencePosition[]): string[] {
  const [first, ...rest] = sides;
  const others = rest.map((side) => new Set(side.observers));
  return first.observers.filter((id) => others.every((observers) => observers.has(id))).sort(compareText);
}

function slotsLabel(ranges: number[][]): string {
  if (countSlots(ranges) === 1) return `Slot ${ranges[0][0]}`;
  const listed = ranges
    .slice(0, MAX_LISTED_RANGES)
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(', ');
  const extra = ranges.length - MAX_LISTED_RANGES;
  return `Slots ${listed}${extra > 0 ? ` +${extra} more ranges` : ''}`;
}

export function summarizeDisagreements(
  round: DisagreementRound | undefined,
  eventOf: (key: string) => DisagreementEvent | undefined,
): TopologyDisagreementSummary {
  if (!round) {
    return {
      status: 'not_sampled',
      sampledAt: null,
      coverage: { nodes: 0, asked: 0, answered: 0, complete: false, unanswered: [], unansweredCount: 0 },
      disagreements: [],
      shards: [],
      shardTotals: { total: 0, disputed: 0, undisputed: 0, notCompared: 0 },
      shardsListed: 'all',
    };
  }

  const { nodes } = round;
  const named = (id: string) => toDivergenceNode(id, nodes);
  const listed = (ids: string[]) => ids.slice(0, DISAGREEMENT_LIST_LIMIT).map(named);
  const nameOf = (id: string) => named(id).address || id.slice(0, SHORT_ID_LENGTH);

  const members = [...nodes.values()].filter(isMember);
  const shards = shardsOf(members, nodes);
  const compared = round.status === 'ok';
  const silent = new Set(round.unanswered);
  const answered = new Set(round.observers.filter((id) => !silent.has(id)));
  const held = [
    ...new Set(round.disagreements.flatMap((entry) => entry.positions.flatMap((position) => position.observers))),
  ]
    .filter((id) => nodes.has(id) && !answered.has(id) && !silent.has(id))
    .sort(compareText);
  const unanswered = [...round.unanswered, ...held];

  const shardsTouching = (subjectIds: string[], slots: number[][] | undefined): string[] => {
    const touched = new Set<string>();
    for (const id of subjectIds) {
      const node = nodes.get(id);
      if (node && isMember(node)) touched.add(shardKeyOf(node, nodes));
    }
    if (slots) {
      for (const shard of shards) {
        if (intersectSlotRanges(shard.slots, slots).length > 0) touched.add(shard.shardId);
      }
    }
    return [...touched].sort(compareText);
  };

  const textOf = (kind: DivergenceKind, subjectIds: string[], slots: number[][], positions: DisagreementPosition[]) => {
    if (kind === 'slot_owner') {
      let ownerSeen = false;
      const sides = positions.map((position) => {
        if (position.value === UNASSIGNED_SLOT_OWNER) return `unassigned in ${viewsOf(position.count)}`;
        const lead = ownerSeen ? 'by' : 'owned by';
        ownerSeen = true;
        return `${lead} ${nameOf(position.value as string)} in ${viewsOf(position.count)}`;
      });
      return `${slotsLabel(slots)}: ${sides.join(', ')}.`;
    }
    const merged = subjectIds.length > 1;
    const who = merged ? `${subjectIds.length} nodes` : nameOf(subjectIds[0]);
    if (kind === 'config_epoch' && merged) {
      return `Config epoch of ${who}: ${positions.map((position) => viewsOf(position.count)).join(' against ')}.`;
    }
    const sides = positions.map((position) => {
      const label = kind === 'membership' ? MEMBERSHIP_LABELS[position.value as string] : undefined;
      return `${label ?? position.value} in ${viewsOf(position.count)}`;
    });
    return `${kind === 'config_epoch' ? `Config epoch of ${who}` : who}: ${sides.join(', ')}.`;
  };

  const staleTextOf = (kind: DivergenceKind, subjectIds: string[], slots: number[][], values: string[]) => {
    if (kind === 'slot_owner') {
      const owners = values.map((value) => (value === UNASSIGNED_SLOT_OWNER ? 'unassigned' : nameOf(value)));
      return `${slotsLabel(slots)}: views differed on the owner (${owners.join(', ')}).`;
    }
    const merged = subjectIds.length > 1;
    const who = merged ? `${subjectIds.length} nodes` : nameOf(subjectIds[0]);
    if (kind === 'config_epoch') return `Config epoch of ${who}: views differed.`;
    if (kind === 'membership') return `${who}: views differed on whether ${merged ? 'they are members' : 'it is a member'}.`;
    return `${who}: views differed on whether ${merged ? 'they are failing' : 'it is failing'}.`;
  };

  const lineOf = (group: Draft[]): DisagreementLine => {
    const drafts = [...group].sort((a, b) => compareText(a.disagreement.key, b.disagreement.key));
    const [first] = drafts;
    const { kind } = first.disagreement;
    const merged = drafts.length > 1;
    const subjectIds = [...new Set(drafts.flatMap((draft) => draft.disagreement.subjectIds))];
    const slots = rangesOf(first.disagreement.slots ?? []);

    const sides = first.positions.map((position, at) => {
      const matches = drafts.map((draft) => draft.positions[at]);
      return {
        value: position.value,
        count: position.observers.length,
        observers: heldByAll(matches),
        values: matches.map((match) => match.value),
      };
    });
    sides.sort(
      (a, b) =>
        b.count - a.count || compareText(a.value, b.value) || compareText(a.observers[0] ?? '', b.observers[0] ?? ''),
    );

    const { stale } = first;
    const perNodeValues = kind === 'config_epoch' && merged && !stale;
    const positions: DisagreementPosition[] = (stale ? [] : sides).map((side) => ({
      value: perNodeValues ? null : side.value,
      ...(kind === 'slot_owner' && side.value !== UNASSIGNED_SLOT_OWNER ? { owner: named(side.value) } : {}),
      count: side.count,
      observers: listed(side.observers),
    }));
    const event = first.event;

    return {
      id: merged ? `${first.disagreement.key}+${drafts.length - 1}` : first.disagreement.key,
      kind,
      severity: DIVERGENCE_SEVERITY_BY_KIND[kind],
      confirmed: event !== undefined,
      eventId: event?.eventId ?? null,
      eventType: event?.eventType ?? null,
      since: Math.min(...drafts.map((draft) => draft.disagreement.firstSeenAt)),
      rounds: Math.max(...drafts.map((draft) => draft.disagreement.rounds)),
      stale,
      lastSeenAt: first.disagreement.lastSeenAt,
      subjects: listed(subjectIds),
      subjectCount: subjectIds.length,
      ...(kind === 'slot_owner' ? { slots, slotCount: countSlots(slots) } : {}),
      shardIds: shardsTouching(subjectIds, kind === 'slot_owner' ? slots : undefined),
      positions,
      ...(perNodeValues
        ? {
            epochs: drafts.slice(0, DISAGREEMENT_LIST_LIMIT).map((draft, at) => ({
              node: named(draft.disagreement.subjectIds[0]),
              values: sides.map((side) => side.values[at]),
            })),
          }
        : {}),
      text: stale
        ? staleTextOf(
            kind,
            subjectIds,
            slots,
            sides.map((side) => side.value),
          )
        : textOf(kind, subjectIds, slots, positions),
    };
  };

  const drafts = round.disagreements.map((disagreement) => ({
    disagreement,
    positions: splitFailing(disagreement, round.failureFlags),
    event: eventOf(disagreement.key),
    stale: !compared || disagreement.lastSeenAt < round.at,
  }));
  const disagreements = mergeDrafts(drafts)
    .map(lineOf)
    .sort(
      (a, b) =>
        Number(a.stale) - Number(b.stale) ||
        SEVERITY_RANK.indexOf(b.severity) - SEVERITY_RANK.indexOf(a.severity) ||
        Number(b.confirmed) - Number(a.confirmed) ||
        a.since - b.since ||
        compareText(a.id, b.id),
    );

  const linesByShard = new Map<string, string[]>();
  const unconfirmed = new Set<string>();
  for (const line of disagreements) {
    for (const shardId of line.shardIds) {
      const ids = linesByShard.get(shardId);
      if (line.stale) unconfirmed.add(shardId);
      else if (ids) ids.push(line.id);
      else linesByShard.set(shardId, [line.id]);
    }
  }

  const shardLines = shards
    .map((shard): ShardLine => {
      const primary = primaryOf(shard.members);
      const disagreementIds = linesByShard.get(shard.shardId) ?? [];
      const settled = unconfirmed.has(shard.shardId) ? 'not_compared' : 'undisputed';
      const state = disagreementIds.length > 0 ? 'disputed' : settled;
      return {
        shardId: shard.shardId,
        primary: primary ? named(primary.id) : null,
        replicas: shard.members.filter((node) => !isPrimary(node)).length,
        zones: [...new Set(shard.members.flatMap((node) => node.availabilityZone ?? []))].sort(compareText),
        slots: shard.slots,
        slotCount: countSlots(shard.slots),
        nodes: shard.members.length,
        ownViews: shard.members.filter((node) => answered.has(node.id)).length,
        state: compared ? state : 'not_compared',
        disagreementIds,
      };
    })
    .sort(
      (a, b) =>
        Number(b.state === 'disputed') - Number(a.state === 'disputed') ||
        (a.slots[0]?.[0] ?? Infinity) - (b.slots[0]?.[0] ?? Infinity) ||
        compareText(a.shardId, b.shardId),
    );

  return {
    status: round.status,
    sampledAt: round.at,
    coverage: {
      nodes: members.length,
      asked: round.observers.length + held.length,
      answered: answered.size,
      complete: compared && members.length > 0 && members.every((node) => answered.has(node.id)),
      unanswered: listed(unanswered),
      unansweredCount: unanswered.length,
    },
    disagreements,
    shards: shardLines,
    shardTotals: totalsOf(shardLines),
    shardsListed: 'all',
  };
}

function totalsOf(shards: ShardLine[]): ShardTotals {
  const count = (state: ShardLine['state']) => shards.filter((shard) => shard.state === state).length;
  return {
    total: shards.length,
    disputed: count('disputed'),
    undisputed: count('undisputed'),
    notCompared: count('not_compared'),
  };
}

export function withDisputedShardsOnly(summary: TopologyDisagreementSummary): TopologyDisagreementSummary {
  return {
    ...summary,
    shards: summary.shards.filter((shard) => shard.state === 'disputed'),
    shardsListed: 'disputed',
  };
}
