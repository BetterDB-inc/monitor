import type { ClusterNodeRef } from '@betterdb/shared';
import { toClusterNodeRef } from '@app/cluster/node-ref';
import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  type DivergenceGroup,
  type DivergenceKind,
  type TrackedDisagreement,
  compareText,
  durationOf,
  intersectSlotRanges,
} from './topology-divergence';
import type { MembershipGap, MembershipPeer, PartialMembership } from './partial-membership';
import { AnomalySeverity } from './types';

export type DivergenceNode = ClusterNodeRef;

export interface DivergenceDetailPosition {
  value: string;
  observers: DivergenceNode[];
}

export interface DivergenceDetailDisagreement {
  kind: DivergenceKind;
  subject: DivergenceNode[];
  slots?: number[][];
  positions: DivergenceDetailPosition[];
  rounds: number;
  since: number;
  eventId: string | null;
  eventType: DivergenceEventType | null;
}

export type DivergenceEventType = 'topology_divergence' | 'partial_membership';

export interface DivergenceEventState {
  eventId: string | null;
  confirmed: boolean;
}

export interface PartialMembershipGapNode extends DivergenceNode {
  status: MembershipGap;
}

export interface PartialMembershipDetail {
  eventId: string | null;
  confirmed: boolean;
  seen: boolean;
  since: number;
  node: DivergenceNode;
  knownBy: DivergenceNode[];
  notKnownBy: PartialMembershipGapNode[];
  ownViewMissing: PartialMembershipGapNode[];
  command: string | null;
  runOn: DivergenceNode[];
  disagreements: DivergenceDetailDisagreement[];
}

export interface TopologyDivergenceDetail {
  eventId: string | null;
  confirmed: boolean;
  since: number;
  sides: Array<{ nodes: DivergenceNode[] }>;
  disagreements: DivergenceDetailDisagreement[];
}

export interface TopologyDivergenceReport {
  status: 'ok' | 'insufficient_views' | 'not_sampled';
  sampledAt: number | null;
  observers: DivergenceNode[];
  unanswered: DivergenceNode[];
  divergences: TopologyDivergenceDetail[];
  partialMembership: PartialMembershipDetail[];
}

export const DIVERGENCE_SEVERITY_BY_KIND: Record<DivergenceKind, AnomalySeverity> = {
  slot_owner: AnomalySeverity.CRITICAL,
  failure_flags: AnomalySeverity.WARNING,
  membership: AnomalySeverity.WARNING,
  config_epoch: AnomalySeverity.WARNING,
};

export const SEVERITY_ORDER = [AnomalySeverity.INFO, AnomalySeverity.WARNING, AnomalySeverity.CRITICAL];
const MAX_LISTED_NODES = 5;
const MAX_LISTED_RANGES = 3;
const SHORT_ID_LENGTH = 8;

export function toDivergenceNode(nodeId: string, nodes: ReadonlyMap<string, ClusterNode>): DivergenceNode {
  const node = nodes.get(nodeId);
  return node ? { ...toClusterNodeRef(node), nodeId } : { nodeId, address: '', role: 'unknown' };
}

function nameOf(nodeId: string, nodes: ReadonlyMap<string, ClusterNode>): string {
  const node = toDivergenceNode(nodeId, nodes);
  const name = node.address || nodeId.slice(0, SHORT_ID_LENGTH);
  return node.availabilityZone ? `${name} (${node.availabilityZone})` : name;
}

function listOf(nodeIds: string[], nodes: ReadonlyMap<string, ClusterNode>): string {
  const listed = nodeIds.slice(0, MAX_LISTED_NODES).map((id) => nameOf(id, nodes)).join(', ');
  const extra = nodeIds.length - MAX_LISTED_NODES;
  return extra > 0 ? `${listed} +${extra} more` : listed;
}

function slotsOf(disagreements: TrackedDisagreement[]): string {
  const ranges = disagreements.flatMap((d) => d.slots ?? []).sort((a, b) => a[0] - b[0]);
  const listed = ranges
    .slice(0, MAX_LISTED_RANGES)
    .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
    .join(', ');
  const extra = ranges.length - MAX_LISTED_RANGES;
  return extra > 0 ? `${listed} +${extra} more ranges` : listed;
}

function topicOf(
  kind: DivergenceKind,
  disagreements: TrackedDisagreement[],
  nodes: ReadonlyMap<string, ClusterNode>,
): string {
  if (kind === 'slot_owner') return `the owner of slots ${slotsOf(disagreements)}`;
  const subjects = [...new Set(disagreements.flatMap((d) => d.subjectIds))];
  const one = subjects.length === 1 ? nameOf(subjects[0], nodes) : null;
  if (kind === 'membership') return one ? `whether ${one} is a member` : `the membership of ${subjects.length} nodes`;
  const what = kind === 'failure_flags' ? 'the failure state' : 'the config epoch';
  return `${what} of ${one ?? `${subjects.length} nodes`}`;
}

export function divergenceSince(group: DivergenceGroup): number {
  return Math.min(...group.disagreements.map((d) => d.firstSeenAt));
}

export function divergenceMessage(
  group: DivergenceGroup,
  nodes: ReadonlyMap<string, ClusterNode>,
  at: number,
): string {
  const kinds: DivergenceKind[] = ['failure_flags', 'membership', 'slot_owner', 'config_epoch'];
  const topics = kinds
    .map((kind) => [kind, group.disagreements.filter((d) => d.kind === kind)] as const)
    .filter(([, found]) => found.length > 0)
    .map(([kind, found]) => topicOf(kind, found, nodes));
  const about = topics.length > 1 ? `${topics.slice(0, -1).join(', ')} and ${topics[topics.length - 1]}` : topics[0];
  const verb = group.dissent.length === 1 ? 'disagrees' : 'disagree';
  return (
    `Cluster views diverge for ${durationOf(at - divergenceSince(group))}: ` +
    `${listOf(group.dissent, nodes)} ${verb} with ${listOf(group.others, nodes)} about ${about}.`
  );
}

export function outranksSeverity(severity: AnomalySeverity, other: AnomalySeverity): boolean {
  return SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(other);
}

export function divergenceSeverity(group: DivergenceGroup): AnomalySeverity {
  const ranks = group.disagreements.map((d) => SEVERITY_ORDER.indexOf(DIVERGENCE_SEVERITY_BY_KIND[d.kind]));
  return SEVERITY_ORDER[Math.max(...ranks)];
}

function namedNodes(ids: string[], nodes: ReadonlyMap<string, ClusterNode>): DivergenceNode[] {
  return ids.map((id) => toDivergenceNode(id, nodes));
}

function namedPeer(peer: MembershipPeer, nodes: ReadonlyMap<string, ClusterNode>): DivergenceNode {
  const [node] = namedNodes([peer.nodeId], nodes);
  return { ...node, address: peer.address || node.address };
}

function toDetailDisagreement(
  disagreement: TrackedDisagreement,
  nodes: ReadonlyMap<string, ClusterNode>,
  held: { eventId: string | null; eventType: DivergenceEventType },
): DivergenceDetailDisagreement {
  return {
    kind: disagreement.kind,
    subject: namedNodes(disagreement.subjectIds, nodes),
    ...(disagreement.slots ? { slots: disagreement.slots } : {}),
    positions: disagreement.positions.map((position) => ({
      value: position.value,
      observers: namedNodes(position.observers, nodes),
    })),
    rounds: disagreement.rounds,
    since: disagreement.firstSeenAt,
    eventId: held.eventId,
    eventType: held.eventId === null ? null : held.eventType,
  };
}

export function raisedDivergenceGroup(
  current: DivergenceGroup | undefined,
  confirmed: DivergenceGroup | undefined,
): DivergenceGroup | undefined {
  if (!current || !confirmed) return current ?? confirmed;
  const confirmedSlots = new Map(confirmed.disagreements.map((entry) => [entry.key, entry.slots ?? []]));
  return {
    ...current,
    disagreements: current.disagreements.map((entry) => {
      const shared = intersectSlotRanges(entry.slots ?? [], confirmedSlots.get(entry.key) ?? []);
      return shared.length > 0 ? { ...entry, slots: shared } : entry;
    }),
  };
}

export function buildDivergenceDetail(
  group: DivergenceGroup,
  nodes: ReadonlyMap<string, ClusterNode>,
  state: DivergenceEventState,
  listed: TrackedDisagreement[] = group.disagreements,
): TopologyDivergenceDetail {
  const held = { eventId: state.eventId, eventType: 'topology_divergence' as const };
  return {
    eventId: state.eventId,
    confirmed: state.confirmed,
    since: divergenceSince(group),
    sides: [{ nodes: namedNodes(group.dissent, nodes) }, { nodes: namedNodes(group.others, nodes) }],
    disagreements: listed.map((disagreement) => toDetailDisagreement(disagreement, nodes, held)),
  };
}

export function disagreementsByFinding(
  findings: Array<{ finding: PartialMembership; eventId: string | null }>,
  disagreements: TrackedDisagreement[],
): Map<string, TrackedDisagreement[]> {
  const listed = new Map<string, TrackedDisagreement[]>();
  for (const disagreement of disagreements) {
    const holds = ({ finding }: { finding: PartialMembership }) =>
      finding.disagreementKeys.includes(disagreement.key) || finding.slotDisputeKeys.includes(disagreement.key);
    const about = (finding: PartialMembership) => Number(disagreement.subjectIds.includes(finding.nodeId));
    const [holder] = findings
      .filter(holds)
      .sort(
        (a, b) =>
          Number(b.eventId !== null) - Number(a.eventId !== null) ||
          about(b.finding) - about(a.finding) ||
          compareText(a.finding.nodeId, b.finding.nodeId),
      );
    if (!holder) continue;
    const own = listed.get(holder.finding.signature);
    if (own) own.push(disagreement);
    else listed.set(holder.finding.signature, [disagreement]);
  }
  return listed;
}

export function buildPartialMembershipDetail(
  finding: PartialMembership,
  disagreements: TrackedDisagreement[],
  nodes: ReadonlyMap<string, ClusterNode>,
  state: DivergenceEventState,
): PartialMembershipDetail {
  const named = (peer: MembershipPeer) => namedPeer(peer, nodes);
  const keys = new Set([...finding.disagreementKeys, ...finding.slotDisputeKeys]);
  const held = { eventId: state.eventId, eventType: 'partial_membership' as const };
  return {
    eventId: state.eventId,
    confirmed: state.confirmed,
    seen: true,
    since: finding.firstSeenAt,
    node: named(finding),
    knownBy: finding.knownBy.map(named),
    notKnownBy: finding.notKnownBy.map((gap) => ({ ...named(gap), status: gap.status })),
    ownViewMissing: finding.ownViewMissing.map((gap) => ({ ...named(gap), status: gap.status })),
    command: finding.meet?.command ?? null,
    runOn: (finding.meet?.runOn ?? []).map(named),
    disagreements: disagreements
      .filter((disagreement) => keys.has(disagreement.key))
      .map((disagreement) => toDetailDisagreement(disagreement, nodes, held)),
  };
}

export function closingPartialMembershipDetail(
  finding: PartialMembership,
  nodes: ReadonlyMap<string, ClusterNode>,
  eventId: string,
): PartialMembershipDetail {
  return {
    eventId,
    confirmed: true,
    seen: false,
    since: finding.firstSeenAt,
    node: namedPeer(finding, nodes),
    knownBy: [],
    notKnownBy: [],
    ownViewMissing: [],
    command: null,
    runOn: [],
    disagreements: [],
  };
}
