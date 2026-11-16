import { isIP } from 'net';
import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  FAILING_FLAGS,
  KNOWN_MEMBER,
  type TopologyDisagreement,
  type TopologyView,
  type TrackedDisagreement,
  UNASSIGNED_SLOT_OWNER,
  compareText,
  sortedUnique,
} from './topology-divergence';
import { normalizeIp, splitHostPort } from './topology-targets';

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

const UNLISTED_FLAGS = ['handshake', 'noaddr'];
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

function isListed(node: ClusterNode): boolean {
  return !node.flags.some((flag) => UNLISTED_FLAGS.includes(flag));
}

function isFailing(node: ClusterNode): boolean {
  return node.flags.some((flag) => FAILING_FLAGS.includes(flag));
}

function isMembership(disagreement: TopologyDisagreement): boolean {
  return disagreement.kind === 'membership';
}

function tierOf(node: ClusterNode | undefined): number {
  if (!node) return TIER_NEW;
  if (node.slots.length > 0) return TIER_SLOT_OWNER;
  return node.flags.includes('slave') ? TIER_REPLICA : TIER_NEW;
}

function endpointOf(node: ClusterNode): Endpoint | null {
  const [address] = node.address.split(',');
  const target = splitHostPort(address);
  if (!target) return null;
  const busPort = Number(address.split('@')[1]);
  return {
    ip: normalizeIp(target.host),
    port: target.port,
    busPort: Number.isInteger(busPort) && busPort > 0 ? busPort : target.port + BUS_PORT_OFFSET,
  };
}

function endpointsOf(nodes: Array<ClusterNode | undefined>): Endpoint[] {
  return nodes
    .filter((node): node is ClusterNode => !!node && isListed(node))
    .map(endpointOf)
    .filter((endpoint): endpoint is Endpoint => !!endpoint);
}

function addressOf(endpoint: Endpoint | null): string {
  return endpoint ? `${endpoint.ip}:${endpoint.port}` : '';
}

function voteOf(endpoint: Endpoint): string {
  return `${addressOf(endpoint)}@${endpoint.busPort}`;
}

function mostCommon(endpoints: Endpoint[], own: Endpoint | undefined): Endpoint | null {
  const votes = new Map<string, { endpoint: Endpoint; count: number }>();
  for (const endpoint of endpoints) {
    const vote = votes.get(voteOf(endpoint));
    if (vote) vote.count += 1;
    else votes.set(voteOf(endpoint), { endpoint, count: 1 });
  }
  const ownVote = own ? voteOf(own) : null;
  const [first] = [...votes.entries()].sort(
    (a, b) => b[1].count - a[1].count || Number(b[0] === ownVote) - Number(a[0] === ownVote) || compareText(a[0], b[0]),
  );
  return first ? first[1].endpoint : null;
}

function lackingObservers(disagreement: TopologyDisagreement): string[] {
  return disagreement.positions
    .filter((position) => position.value !== KNOWN_MEMBER)
    .flatMap((position) => position.observers);
}

export function membershipSightings(
  views: TopologyView[],
  disagreements: TopologyDisagreement[],
): Map<string, MembershipSighting[]> {
  const wanted = new Set(
    disagreements
      .filter(isMembership)
      .flatMap((disagreement) => [...disagreement.subjectIds, ...lackingObservers(disagreement)]),
  );
  const sightings = new Map<string, MembershipSighting[]>();
  if (wanted.size === 0) return sightings;
  for (const view of views) {
    for (const node of view.nodes) {
      if (!wanted.has(node.id) || !isListed(node)) continue;
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
  const bySubject = new Map(memberships.map((disagreement) => [disagreement.subjectIds[0], disagreement]));

  const endpoints = new Map<string, Endpoint | null>();
  const endpointFor = (id: string): Endpoint | null => {
    if (endpoints.has(id)) return endpoints.get(id) as Endpoint | null;
    const seen = sightings.get(id) ?? [];
    const fromItself = seen.filter((sighting) => sighting.observerId === id).map((sighting) => sighting.node);
    const fromPeers = seen.filter((sighting) => sighting.observerId !== id).map((sighting) => sighting.node);
    const [own] = endpointsOf([...fromItself, selves.get(id)]);
    const endpoint = mostCommon(endpointsOf(fromPeers), own) ?? own ?? endpointsOf([nodes.get(id)])[0] ?? null;
    endpoints.set(id, endpoint);
    return endpoint;
  };

  const peer = (id: string): MembershipPeer => ({ nodeId: id, address: addressOf(endpointFor(id)) });

  const claims = (link: Link): boolean => {
    const seen = sightings.get(link.subject) ?? [];
    if (selves.has(link.subject)) return true;
    const others = seen.filter((sighting) => sighting.observerId !== link.subject);
    if (others.length === 0) return open.has(link.subject) || open.has(link.observer);
    return !others.every((sighting) => isFailing(sighting.node));
  };

  const tiers = new Map<string, number>();
  const tier = (id: string): number => {
    const known = tiers.get(id);
    if (known !== undefined) return known;
    const found = tierOf(selves.get(id) ?? sightings.get(id)?.[0]?.node ?? nodes.get(id));
    tiers.set(id, found);
    return found;
  };

  const links = memberships
    .flatMap((disagreement): Link[] => {
      const [subject] = disagreement.subjectIds;
      return disagreement.positions
        .filter((position) => position.value !== KNOWN_MEMBER)
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

  const lacked = new Map<string, Set<string>>();
  for (const link of links) {
    const subjects = lacked.get(link.observer);
    if (subjects) subjects.add(link.subject);
    else lacked.set(link.observer, new Set([link.subject]));
  }
  const lacks = (observer: string, subject: string): boolean => !!lacked.get(observer)?.has(subject);

  const newerEnd = (link: Link): string => {
    const { observer, subject } = link;
    if (tier(observer) !== tier(subject)) return tier(observer) < tier(subject) ? observer : subject;
    if (!lacks(subject, observer)) return subject;
    if (open.has(observer) !== open.has(subject)) return open.has(observer) ? observer : subject;
    return compareText(observer, subject) < 0 ? observer : subject;
  };

  const filed = new Map<string, Link[]>();
  for (const link of links) {
    const hub = newerEnd(link);
    const own = filed.get(hub);
    if (own) own.push(link);
    else filed.set(hub, [link]);
  }

  const explained = slotDisputesExplainedBy(
    input.disagreements,
    (id, owner) => tier(id) < TIER_SLOT_OWNER && lacks(id, owner),
  );

  const found = [...filed].map(([hub, own]): PartialMembership => {
    const about = bySubject.get(hub);
    const knowers = about
      ? about.positions.filter((position) => position.value === KNOWN_MEMBER).flatMap((position) => position.observers)
      : own.flatMap((link) => (byKey.get(link.key) as TrackedDisagreement).positions).flatMap((side) => side.observers);
    const history = own.map((link) => {
      const dispute = byKey.get(link.key) as TrackedDisagreement;
      const { firstSeenAt, rounds } = (link.observer === hub && dispute.gapStreaks?.[hub]) || dispute;
      return { firstSeenAt, rounds, seen: dispute.lastSeenAt >= at };
    });
    const read = own.filter((link) => link.answered);
    const gapPeers = (ids: Link[], end: 'observer' | 'subject'): MembershipGapPeer[] =>
      ids
        .map((link) => ({ ...peer(link[end]), status: link.status }))
        .sort((a, b) => compareText(a.nodeId, b.nodeId));
    const notKnownBy = gapPeers(read.filter((link) => link.subject === hub), 'observer');
    const ownViewMissing = gapPeers(read.filter((link) => link.observer === hub), 'subject');
    const endpoint = endpointFor(hub);
    const runOn = sortedUnique([...notKnownBy, ...ownViewMissing].map((gap) => gap.nodeId)).map(peer);

    return {
      signature: partialMembershipSignature(hub),
      nodeId: hub,
      address: addressOf(endpoint),
      knownBy: sortedUnique(knowers)
        .filter((id) => id !== hub && selves.has(id))
        .map(peer),
      notKnownBy,
      ownViewMissing,
      disagreementKeys: sortedUnique(own.map((link) => link.key)),
      slotDisputeKeys: explained.filter(({ nodeIds }) => nodeIds.includes(hub)).map(({ key }) => key),
      firstSeenAt: Math.min(...history.map((entry) => entry.firstSeenAt)),
      rounds: Math.max(...history.map((entry) => entry.rounds)),
      confirmed: history.some(
        (entry) => entry.seen && entry.rounds >= minRounds && at - entry.firstSeenAt >= minAgeMs,
      ),
      ...(endpoint && isIP(endpoint.ip) && runOn.length > 0 ? { meet: meetCommand(endpoint, runOn) } : {}),
    };
  });

  return found.sort((a, b) => compareText(a.nodeId, b.nodeId));
}

function slotDisputesExplainedBy(
  disagreements: TrackedDisagreement[],
  lacksOwner: (id: string, owner: string) => boolean,
): Array<{ key: string; nodeIds: string[] }> {
  return disagreements.flatMap((dispute) => {
    if (dispute.kind !== 'slot_owner' || dispute.positions.length !== 2) return [];
    const unassigned = dispute.positions.find((position) => position.value === UNASSIGNED_SLOT_OWNER);
    const owner = dispute.positions.find((position) => position.value !== UNASSIGNED_SLOT_OWNER);
    if (!unassigned || !owner) return [];
    const explained = unassigned.observers.every((id) => lacksOwner(id, owner.value));
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

export type MembershipSide = 'partial_membership' | 'topology_divergence';

export interface PartialMembershipRound {
  found: PartialMembership[];
  sides: Map<string, MembershipSide>;
}

export function membershipSides(
  disagreements: TrackedDisagreement[],
  found: PartialMembership[],
  at: number,
  previous: ReadonlyMap<string, MembershipSide> = new Map(),
): Map<string, MembershipSide> {
  const claimed = new Set(found.flatMap((finding) => finding.disagreementKeys));
  return new Map(
    disagreements.filter(isMembership).map(({ key, lastSeenAt }): [string, MembershipSide] => {
      const side = claimed.has(key) ? 'partial_membership' : 'topology_divergence';
      return [key, lastSeenAt >= at ? side : (previous.get(key) ?? side)];
    }),
  );
}

export function renamedPartialMemberships(
  open: ReadonlyMap<string, { group?: PartialMembership }>,
  found: PartialMembership[],
  answered: ReadonlySet<string>,
): string[] {
  const current = new Set(found.map((finding) => finding.signature));
  const held = new Set(found.flatMap((finding) => finding.disagreementKeys));
  const read = (finding: PartialMembership) =>
    [finding.nodeId, ...finding.notKnownBy.map((peer) => peer.nodeId)].every((nodeId) => answered.has(nodeId));
  const lost = (finding: PartialMembership) =>
    !current.has(finding.signature) && read(finding) && finding.disagreementKeys.some((key) => held.has(key));
  return [...open].filter(([, entry]) => entry.group && lost(entry.group)).map(([signature]) => signature);
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

function whyNoCommand(finding: PartialMembership): string {
  if (!finding.address) return 'No view has an address for it, so no CLUSTER MEET command can be given.';
  if (finding.notKnownBy.length + finding.ownViewMissing.length === 0) {
    return 'No node that showed the gap gave a view this round, so no CLUSTER MEET command can be given.';
  }
  return (
    `Its address ${finding.address} has a host name where CLUSTER MEET needs an IP address, ` +
    'so no command can be given.'
  );
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
  if (!meet) return [...parts, whyNoCommand(finding)].join(' ');
  parts.push(
    `Run \`${meet.command}\` on ${listOf(meet.runOn.map(nameOf))}.`,
    `If it still does not join, check that cluster bus port ${meet.busPort} is reachable between them.`,
    'BetterDB does not run this command.',
  );
  return parts.join(' ');
}
