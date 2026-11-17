import { isIP } from 'net';
import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  type MembershipGap,
  type TopologyDisagreement,
  type TopologyView,
  type TrackedDisagreement,
  UNASSIGNED_SLOT_OWNER,
  compareText,
  durationOf,
  isFlaggedFailing,
  isKnownMember,
  lackingObservers,
  sortedUnique,
} from './topology-divergence';
import { normalizeIp, splitHostPort } from './topology-targets';

export const PARTIAL_MEMBERSHIP_SIGNATURE_PREFIX = 'partial_membership:';
export const PARTIAL_MEMBERSHIP_MIN_AGE_MS = 90_000;

export type { MembershipGap };

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
  brokenPeers: number;
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

type MembershipDispute = TopologyDisagreement & Pick<Partial<TrackedDisagreement>, 'gapStreaks'>;

interface Link {
  observer: string;
  subject: string;
  status: MembershipGap;
  key: string;
  answered: boolean;
  gone: boolean;
}

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

function isMembership(disagreement: TopologyDisagreement): boolean {
  return disagreement.kind === 'membership';
}

function tierOf(node: ClusterNode | undefined): number {
  if (!node) return TIER_NEW;
  if (node.slots.length > 0) return TIER_SLOT_OWNER;
  return node.flags.includes('slave') || node.flags.includes('replica') ? TIER_REPLICA : TIER_NEW;
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
    .filter((node): node is ClusterNode => !!node && isKnownMember(node))
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

export function membershipSightings(
  views: TopologyView[],
  disagreements: MembershipDispute[],
): Map<string, MembershipSighting[]> {
  const wanted = new Set(
    disagreements
      .filter(isMembership)
      .flatMap((disagreement) => [
        ...disagreement.subjectIds,
        ...lackingObservers(disagreement).map(({ observer }) => observer),
        ...Object.keys(disagreement.gapStreaks ?? {}),
      ]),
  );
  const sightings = new Map<string, MembershipSighting[]>();
  if (wanted.size === 0) return sightings;
  for (const view of views) {
    for (const node of view.nodes) {
      if (!wanted.has(node.id) || !isKnownMember(node)) continue;
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

  const peerSightings = (id: string): MembershipSighting[] =>
    (sightings.get(id) ?? []).filter((sighting) => sighting.observerId !== id);
  const failingForAll = (id: string): boolean => {
    const seen = peerSightings(id);
    return seen.length > 0 && seen.every((sighting) => isFlaggedFailing(sighting.node));
  };

  const endpoints = new Map<string, Endpoint | null>();
  const endpointFor = (id: string): Endpoint | null => {
    if (endpoints.has(id)) return endpoints.get(id) as Endpoint | null;
    const fromPeers = peerSightings(id).map((sighting) => sighting.node);
    const trusted = fromPeers.filter((node) => !isFlaggedFailing(node));
    const [own] = endpointsOf([selves.get(id)]);
    const endpoint =
      mostCommon(endpointsOf(trusted), own) ??
      own ??
      mostCommon(endpointsOf(fromPeers), undefined) ??
      endpointsOf([nodes.get(id)])[0] ??
      null;
    endpoints.set(id, endpoint);
    return endpoint;
  };

  const peer = (id: string): MembershipPeer => ({ nodeId: id, address: addressOf(endpointFor(id)) });

  const claims = (link: Link): boolean => {
    if (!selves.has(link.observer) && failingForAll(link.observer)) return false;
    if (selves.has(link.subject)) return true;
    if (peerSightings(link.subject).length === 0) return open.has(link.subject) || open.has(link.observer);
    return !failingForAll(link.subject);
  };

  const links = memberships
    .flatMap((disagreement): Link[] => {
      const [subject] = disagreement.subjectIds;
      const streaks = disagreement.gapStreaks;
      const shown = new Map(lackingObservers(disagreement).map(({ observer, status }) => [observer, status]));
      return sortedUnique([...shown.keys(), ...Object.keys(streaks ?? {})]).map((observer) => {
        const status = shown.get(observer);
        const gone = !!streaks && !streaks[observer];
        return {
          observer,
          subject,
          status: status ?? 'missing',
          key: disagreement.key,
          answered: !!status && !gone && selves.has(observer),
          gone,
        };
      });
    })
    .filter(claims);

  const lacked = new Map<string, Set<string>>();
  const lackedBy = new Map<string, Set<string>>();
  const note = (pairs: Map<string, Set<string>>, from: string, to: string): void => {
    const ends = pairs.get(from);
    if (ends) ends.add(to);
    else pairs.set(from, new Set([to]));
  };
  for (const link of links.filter((link) => !link.gone)) {
    note(lacked, link.observer, link.subject);
    note(lackedBy, link.subject, link.observer);
  }
  const lacks = (observer: string, subject: string): boolean => !!lacked.get(observer)?.has(subject);
  const lackers = (id: string): number => lackedBy.get(id)?.size ?? 0;

  const tiers = new Map<string, number>();
  const shownTier = (id: string): number => {
    const known = tiers.get(id);
    if (known !== undefined) return known;
    const own = selves.get(id);
    const seen = own ? [own] : [...(sightings.get(id) ?? []).map((sighting) => sighting.node), nodes.get(id)];
    const found = Math.max(...seen.map(tierOf));
    tiers.set(id, found);
    return found;
  };
  const tierAgainst = (id: string, other: string): number => {
    const shown = shownTier(id);
    if (shown !== TIER_NEW || shownTier(other) !== TIER_REPLICA) return shown;
    const lackedByOwner = [...(lackedBy.get(id) ?? [])].some((observer) => shownTier(observer) === TIER_SLOT_OWNER);
    return lackedByOwner ? TIER_NEW : TIER_REPLICA;
  };

  const newerEnd = (link: Link): string => {
    const { observer, subject } = link;
    const observerTier = tierAgainst(observer, subject);
    const subjectTier = tierAgainst(subject, observer);
    if (observerTier !== subjectTier) return observerTier < subjectTier ? observer : subject;
    if (!lacks(subject, observer)) return subject;
    if (open.has(observer) !== open.has(subject)) return open.has(observer) ? observer : subject;
    if (lackers(observer) !== lackers(subject)) return lackers(observer) > lackers(subject) ? observer : subject;
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
    (id, owner) => shownTier(id) < TIER_SLOT_OWNER && lacks(id, owner),
  );

  const found = [...filed].map(([hub, own]): PartialMembership => {
    const knowers = (sightings.get(hub) ?? []).map((sighting) => sighting.observerId);
    const lasting = own.filter((link) => !link.gone);
    const kept = lasting.length > 0 ? lasting : own;
    const history = kept.map((link) => {
      const dispute = byKey.get(link.key) as TrackedDisagreement;
      const streak = dispute.gapStreaks?.[link.observer];
      const { firstSeenAt, rounds } = streak ?? dispute;
      return { firstSeenAt, rounds, seen: dispute.lastSeenAt >= at && (streak?.lastAnsweredAt ?? at) >= at };
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
        .filter((id) => id !== hub)
        .map(peer),
      notKnownBy,
      ownViewMissing,
      brokenPeers: new Set(lasting.map((link) => (link.observer === hub ? link.subject : link.observer))).size,
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
  const held = new Set(found.filter((finding) => finding.confirmed).flatMap((finding) => finding.disagreementKeys));
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
