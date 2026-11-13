import type { ClusterNode } from '@app/common/types/metrics.types';
import type { DivergenceGroup, DivergenceKind, TrackedDisagreement } from './topology-divergence';
import { AnomalySeverity } from './types';

export interface DivergenceNode {
  nodeId: string;
  address: string;
  role: 'primary' | 'replica' | 'unknown';
  shardId?: string;
  availabilityZone?: string;
}

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
}

export const DIVERGENCE_SEVERITY_BY_KIND: Record<DivergenceKind, AnomalySeverity> = {
  slot_owner: AnomalySeverity.CRITICAL,
  failure_flags: AnomalySeverity.WARNING,
  membership: AnomalySeverity.WARNING,
  config_epoch: AnomalySeverity.WARNING,
};

const SEVERITY_ORDER = [AnomalySeverity.INFO, AnomalySeverity.WARNING, AnomalySeverity.CRITICAL];
const MAX_LISTED_NODES = 5;
const MAX_LISTED_RANGES = 3;
const SHORT_ID_LENGTH = 8;

export function toDivergenceNode(nodeId: string, nodes: ReadonlyMap<string, ClusterNode>): DivergenceNode {
  const node = nodes.get(nodeId);
  if (!node) return { nodeId, address: '', role: 'unknown' };
  return {
    nodeId,
    address: node.address.split('@')[0],
    role: node.flags.includes('master') ? 'primary' : 'replica',
    ...(node.shardId ? { shardId: node.shardId } : {}),
    ...(node.availabilityZone ? { availabilityZone: node.availabilityZone } : {}),
  };
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

function durationOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
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

export function buildDivergenceDetail(
  group: DivergenceGroup,
  nodes: ReadonlyMap<string, ClusterNode>,
  state: { eventId: string | null; confirmed: boolean },
): TopologyDivergenceDetail {
  const named = (ids: string[]) => ids.map((id) => toDivergenceNode(id, nodes));
  return {
    eventId: state.eventId,
    confirmed: state.confirmed,
    since: divergenceSince(group),
    sides: [{ nodes: named(group.dissent) }, { nodes: named(group.others) }],
    disagreements: group.disagreements.map((d) => ({
      kind: d.kind,
      subject: named(d.subjectIds),
      ...(d.slots ? { slots: d.slots } : {}),
      positions: d.positions.map((position) => ({ value: position.value, observers: named(position.observers) })),
      rounds: d.rounds,
      since: d.firstSeenAt,
    })),
  };
}
