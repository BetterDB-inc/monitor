import { isIP } from 'net';
import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  type TopologyDisagreement,
  type TopologyView,
  type TrackedDisagreement,
  UNASSIGNED_SLOT_OWNER,
} from './topology-divergence';

export const PARTIAL_MEMBERSHIP_SIGNATURE_PREFIX = 'partial_membership:';
export const PARTIAL_MEMBERSHIP_MIN_AGE_MS = 90_000;

export type MembershipGap = 'missing' | 'handshake' | 'noaddr';

export interface MembershipSighting {
  observerId: string;
  node: ClusterNode;
}

export interface MembershipPeer {
  nodeId: string;
  address: string;
}

export interface MembershipGapPeer extends MembershipPeer {
  status: MembershipGap;
}

export interface MeetCommand {
  ip: string;
  port: number;
  busPort: number;
  command: string;
  runOn: MembershipPeer[];
}

export interface PartialMembership {
  signature: string;
  nodeId: string;
  address: string;
  knownBy: MembershipPeer[];
  notKnownBy: MembershipGapPeer[];
  ownViewMissing: MembershipGapPeer[];
  disagreementKeys: string[];
  slotDisputeKeys: string[];
  firstSeenAt: number;
  rounds: number;
  confirmed: boolean;
  meet?: MeetCommand;
}

export interface PartialMembershipInput {
  disagreements: TrackedDisagreement[];
  sightings: ReadonlyMap<string, MembershipSighting[]>;
  nodes: ReadonlyMap<string, ClusterNode>;
  selves: ReadonlyMap<string, ClusterNode>;
  at: number;
  minRounds: number;
  minAgeMs?: number;
  openNodeIds?: ReadonlySet<string>;
}

interface Endpoint {
  ip: string;
  port: number;
  busPort: number;
}

interface Link {
  observer: string;
  subject: string;
  status: MembershipGap;
  key: string;
  answered: boolean;
}

const KNOWN = 'known';
const UNLISTED_FLAGS = ['handshake', 'noaddr'];
const FAILING_FLAGS = ['fail', 'fail?'];
const BUS_PORT_OFFSET = 10_000;
const SHORT_ID_LENGTH = 8;
const TIER_NEW = 0;
const TIER_REPLICA = 1;
const TIER_SLOT_OWNER = 2;
const GAP_LABELS: Record<MembershipGap, string> = {
  missing: 'missing',
  handshake: 'stuck in handshake',
  noaddr: 'no address',
};

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText);
}

function isListed(node: ClusterNode): boolean {
  return !node.flags.some((flag) => UNLISTED_FLAGS.includes(flag));
}

function isFailing(node: ClusterNode): boolean {
  return node.flags.some((flag) => FAILING_FLAGS.includes(flag));
}

function isMembership(disagreement: TopologyDisagreement): boolean {
  return disagreement.kind === 'membership';
}

function endpointOf(node: ClusterNode): Endpoint | null {
  const [hostPort, bus] = node.address.split(',')[0].split('@');
  const colon = hostPort.lastIndexOf(':');
  if (colon <= 0) return null;
  const ip = hostPort.slice(0, colon);
  const port = Number(hostPort.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  const busPort = Number(bus);
  return { ip, port, busPort: Number.isInteger(busPort) && busPort > 0 ? busPort : port + BUS_PORT_OFFSET };
}

function addressOf(endpoint: Endpoint | null): string {
  return endpoint ? `${endpoint.ip}:${endpoint.port}` : '';
}

function mostCommon(endpoints: Endpoint[]): Endpoint | null {
  const votes = new Map<string, { endpoint: Endpoint; count: number }>();
  for (const endpoint of endpoints) {
    const address = addressOf(endpoint);
    const vote = votes.get(address);
    if (vote) vote.count += 1;
    else votes.set(address, { endpoint, count: 1 });
  }
  const [first] = [...votes.entries()].sort((a, b) => b[1].count - a[1].count || compareText(a[0], b[0]));
  return first ? first[1].endpoint : null;
}

export function membershipSightings(
  views: TopologyView[],
  disagreements: TopologyDisagreement[],
): Map<string, MembershipSighting[]> {
  const disputed = new Set(disagreements.filter(isMembership).flatMap((disagreement) => disagreement.subjectIds));
  const sightings = new Map<string, MembershipSighting[]>();
  if (disputed.size === 0) return sightings;
  for (const view of views) {
    for (const node of view.nodes) {
      if (!disputed.has(node.id) || !isListed(node)) continue;
      const seen = sightings.get(node.id);
      if (seen) seen.push({ observerId: view.observerId, node });
      else sightings.set(node.id, [{ observerId: view.observerId, node }]);
    }
  }
  return sightings;
}

export function partialMembershipSignature(nodeId: string): string {
  return `${PARTIAL_MEMBERSHIP_SIGNATURE_PREFIX}${nodeId}`;
}

export function partialMembershipNodeId(dedupeKey: string | undefined): string | null {
  if (!dedupeKey?.startsWith(PARTIAL_MEMBERSHIP_SIGNATURE_PREFIX)) return null;
  return dedupeKey.slice(PARTIAL_MEMBERSHIP_SIGNATURE_PREFIX.length) || null;
}

export function partiallyKnownNodes(input: PartialMembershipInput): PartialMembership[] {
  const { sightings, nodes, selves, at, minRounds } = input;
  const minAgeMs = input.minAgeMs ?? PARTIAL_MEMBERSHIP_MIN_AGE_MS;
  const open = input.openNodeIds ?? new Set<string>();
  const memberships = input.disagreements.filter(isMembership);
  const byKey = new Map(memberships.map((disagreement) => [disagreement.key, disagreement]));

  const describe = (id: string): ClusterNode | undefined =>
    selves.get(id) ?? sightings.get(id)?.[0]?.node ?? nodes.get(id);

  const endpointFor = (id: string): Endpoint | null => {
    const fallback = [selves.get(id), nodes.get(id)].filter((node): node is ClusterNode => !!node && isListed(node));
    const seen = (sightings.get(id) ?? []).map((sighting) => sighting.node);
    const read = (found: ClusterNode[]) => found.map(endpointOf).filter((endpoint): endpoint is Endpoint => !!endpoint);
    return mostCommon(read(seen)) ?? read(fallback)[0] ?? null;
  };

  const peer = (id: string): MembershipPeer => ({ nodeId: id, address: addressOf(endpointFor(id)) });

  const claims = (link: Link): boolean => {
    const seen = sightings.get(link.subject) ?? [];
    if (selves.has(link.subject)) return true;
    const others = seen.filter((sighting) => sighting.observerId !== link.subject);
    if (others.length === 0) return open.has(link.subject) || open.has(link.observer);
    return !others.every((sighting) => isFailing(sighting.node));
  };

  const tier = (id: string): number => {
    const node = describe(id);
    if (!node) return TIER_NEW;
    if (node.slots.length > 0) return TIER_SLOT_OWNER;
    return node.flags.includes('slave') ? TIER_REPLICA : TIER_NEW;
  };

  const newerEnd = (link: Link): string => (tier(link.observer) < tier(link.subject) ? link.observer : link.subject);

  let links = memberships
    .flatMap((disagreement): Link[] => {
      const [subject] = disagreement.subjectIds;
      return disagreement.positions
        .filter((position) => position.value !== KNOWN)
        .flatMap((position) =>
          position.observers.map((observer) => ({
            observer,
            subject,
            status: position.value as MembershipGap,
            key: disagreement.key,
            answered: selves.has(observer),
          })),
        );
    })
    .filter(claims);

  const found: PartialMembership[] = [];
  const lacking = new Map<string, Set<string>>();
  while (links.length > 0) {
    const degree = new Map<string, number>();
    for (const link of links) {
      for (const id of [link.observer, link.subject]) degree.set(id, (degree.get(id) ?? 0) + 1);
    }
    const [hub] = sortedUnique(links.map(newerEnd)).sort(
      (a, b) =>
        (degree.get(b) as number) - (degree.get(a) as number) ||
        Number(open.has(b)) - Number(open.has(a)) ||
        compareText(a, b),
    );
    const own = links.filter((link) => link.observer === hub || link.subject === hub);
    links = links.filter((link) => !own.includes(link));
    if (tier(hub) < TIER_SLOT_OWNER) {
      lacking.set(hub, new Set(own.filter((link) => link.observer === hub).map((link) => link.subject)));
    }

    const disputes = sortedUnique(own.map((link) => link.key)).map((key) => byKey.get(key) as TrackedDisagreement);
    const about = memberships.find((disagreement) => disagreement.subjectIds[0] === hub);
    const knowers = about
      ? about.positions.filter((position) => position.value === KNOWN).flatMap((position) => position.observers)
      : disputes.flatMap((dispute) => dispute.positions.flatMap((position) => position.observers));
    const read = own.filter((link) => link.answered);
    const gapPeers = (ids: Link[], end: 'observer' | 'subject'): MembershipGapPeer[] =>
      ids
        .map((link) => ({ ...peer(link[end]), status: link.status }))
        .sort((a, b) => compareText(a.nodeId, b.nodeId));
    const notKnownBy = gapPeers(read.filter((link) => link.subject === hub), 'observer');
    const ownViewMissing = gapPeers(read.filter((link) => link.observer === hub), 'subject');
    const endpoint = endpointFor(hub);
    const runOn = sortedUnique([...notKnownBy, ...ownViewMissing].map((gap) => gap.nodeId)).map(peer);

    found.push({
      signature: partialMembershipSignature(hub),
      nodeId: hub,
      address: addressOf(endpoint),
      knownBy: sortedUnique(knowers)
        .filter((id) => id !== hub && selves.has(id))
        .map(peer),
      notKnownBy,
      ownViewMissing,
      disagreementKeys: disputes.map((dispute) => dispute.key),
      slotDisputeKeys: [],
      firstSeenAt: Math.min(...disputes.map((dispute) => dispute.firstSeenAt)),
      rounds: Math.max(...disputes.map((dispute) => dispute.rounds)),
      confirmed: disputes.some(
        (dispute) => dispute.lastSeenAt >= at && dispute.rounds >= minRounds && at - dispute.firstSeenAt >= minAgeMs,
      ),
      ...(endpoint && isIP(endpoint.ip) ? { meet: meetCommand(endpoint, runOn) } : {}),
    });
  }

  for (const { key, nodeIds } of slotDisputesExplainedBy(input.disagreements, lacking)) {
    for (const finding of found) {
      if (nodeIds.includes(finding.nodeId)) finding.slotDisputeKeys.push(key);
    }
  }

  return found.sort((a, b) => compareText(a.nodeId, b.nodeId));
}

function slotDisputesExplainedBy(
  disagreements: TrackedDisagreement[],
  lacking: ReadonlyMap<string, ReadonlySet<string>>,
): Array<{ key: string; nodeIds: string[] }> {
  return disagreements.flatMap((dispute) => {
    if (dispute.kind !== 'slot_owner' || dispute.positions.length !== 2) return [];
    const unassigned = dispute.positions.find((position) => position.value === UNASSIGNED_SLOT_OWNER);
    const owner = dispute.positions.find((position) => position.value !== UNASSIGNED_SLOT_OWNER);
    if (!unassigned || !owner) return [];
    const explained = unassigned.observers.every((id) => lacking.get(id)?.has(owner.value));
    return explained ? [{ key: dispute.key, nodeIds: unassigned.observers }] : [];
  });
}

function meetCommand(endpoint: Endpoint, runOn: MembershipPeer[]): MeetCommand {
  const standardBus = endpoint.busPort === endpoint.port + BUS_PORT_OFFSET;
  return {
    ...endpoint,
    command: `CLUSTER MEET ${endpoint.ip} ${endpoint.port}${standardBus ? '' : ` ${endpoint.busPort}`}`,
    runOn,
  };
}

export function unclaimedByPartialMembership<T extends { key: string }>(
  disagreements: T[],
  found: PartialMembership[],
): T[] {
  const claimed = new Set(found.flatMap((finding) => [...finding.disagreementKeys, ...finding.slotDisputeKeys]));
  return disagreements.filter((disagreement) => !claimed.has(disagreement.key));
}

function nameOf(peer: MembershipPeer): string {
  return peer.address || peer.nodeId.slice(0, SHORT_ID_LENGTH);
}

function listOf(names: string[]): string {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function durationOf(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
}

export function partialMembershipMessage(finding: PartialMembership, at: number): string {
  const { knownBy, notKnownBy, ownViewMissing, meet } = finding;
  const parts = [
    `Node ${nameOf(finding)} has only partly joined the cluster for ${durationOf(at - finding.firstSeenAt)}.`,
    knownBy.length > 0 ? `Known by ${knownBy.map(nameOf).join(', ')}.` : 'Known by none of the sampled nodes.',
  ];
  if (notKnownBy.length > 0) {
    parts.push(`Not known by ${notKnownBy.map((gap) => `${nameOf(gap)} (${GAP_LABELS[gap.status]})`).join(', ')}.`);
  }
  if (ownViewMissing.length > 0) parts.push(`Its own view is missing ${ownViewMissing.map(nameOf).join(', ')}.`);
  if (!meet) {
    parts.push(
      finding.address
        ? `Its address ${finding.address} has a host name where CLUSTER MEET needs an IP address, ` +
            'so no command can be given.'
        : 'No view has an address for it, so no CLUSTER MEET command can be given.',
    );
    return parts.join(' ');
  }
  parts.push(
    `Run \`${meet.command}\` on ${listOf(meet.runOn.map(nameOf))}.`,
    `If it still does not join, check that cluster bus port ${meet.busPort} is reachable between them.`,
    'BetterDB does not run this command.',
  );
  return parts.join(' ');
}
