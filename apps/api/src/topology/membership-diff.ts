import type { TopologyKind, TopologyMembership, TopologyRole } from '@betterdb/shared';
import type { DiscoveredNode } from '../cluster/cluster-discovery.service';

export interface DesiredNode {
  host: string;
  port: number;
  nodeId: string;
  source: TopologyKind;
  group?: string;
  role?: TopologyRole;
  hostname?: string;
}

export interface MemberPatch {
  id: string;
  node: DesiredNode;
}

export interface MemberSnapshot {
  id: string;
  host: string;
  port: number;
  membership: TopologyMembership;
}

export interface AddressOwner {
  id: string;
  connectionType: 'direct' | 'external';
  membership?: TopologyMembership;
  isSeed?: boolean;
}

export type AddressLookup = (host: string, port: number) => AddressOwner | null;

export type SkipReason = 'claimed' | 'external' | 'occupied' | 'seed';

export interface MembershipDiff {
  add: DesiredNode[];
  adopt: MemberPatch[];
  reactivate: MemberPatch[];
  refresh: MemberPatch[];
  retire: string[];
  skipped: Array<{ host: string; port: number; reason: SkipReason }>;
}

const EXCLUDED_FLAGS = ['myself', 'noaddr', 'handshake'];

export function addressKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

export function parseNodeAddress(address: string): { host: string; port: number } | null {
  const hostPort = address.split('@')[0];
  const separator = hostPort.lastIndexOf(':');
  if (separator <= 0) return null;
  const host = hostPort.slice(0, separator).replace(/^\[(.*)\]$/, '$1');
  const port = Number(hostPort.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

export interface DiscoveryOptions {
  /**
   * The seed host stands for more than one node (see `seedIsAlias`): discovery
   * lands on whichever node it routes to, so `myself` is a real node to keep.
   */
  seedIsAlias?: boolean;
}

const GHOST_FLAGS = ['fail', 'fail?', 'noaddr', 'handshake'];

/**
 * Whether the seed host is an alias rather than one node. It is one node when
 * the seed host or its resolved addresses match, on the seed port, exactly the
 * node that answered discovery: an IP literal, a pod DNS name, a dual-stack
 * name for one node. When they match several nodes (a Kubernetes headless
 * Service, round-robin DNS), each discovery lands on an arbitrary node and
 * `myself` is not the seed.
 * When they match none, the addresses cannot tell (a ClusterIP Service or load
 * balancer VIP, or one node behind NAT, a port mapping or a tunnel), so this
 * returns null and the caller decides from which nodes answered over time.
 * An announced hostname is not enough on its own: any node can announce a name
 * that a Service in front of several nodes also answers to.
 */
export function seedIsAlias(
  seed: { host: string; port: number },
  seedAddresses: string[],
  nodes: DiscoveredNode[],
): boolean | null {
  const seedHosts = new Set([seed.host, ...seedAddresses].map((address) => address.toLowerCase()));
  const matched = nodes.filter((node) => {
    // A failed or suspected-failed node, or a handshake, left behind on a reused IP is not a node
    // the seed reaches; only `myself` counts whatever its flags.
    if (!node.flags.includes('myself') && node.flags.some((flag) => GHOST_FLAGS.includes(flag))) return false;
    const parsed = parseNodeAddress(node.address);
    return parsed !== null && parsed.port === seed.port && seedHosts.has(parsed.host.toLowerCase());
  });
  if (matched.length === 0) return null;
  return !(matched.length === 1 && matched[0].flags.includes('myself'));
}

export function desiredFromDiscovery(
  seed: { host: string; port: number },
  nodes: DiscoveredNode[],
  options: DiscoveryOptions = {},
): DesiredNode[] {
  const seedKey = addressKey(seed.host, seed.port);
  const excluded = options.seedIsAlias ? EXCLUDED_FLAGS.filter((flag) => flag !== 'myself') : EXCLUDED_FLAGS;
  const desired: DesiredNode[] = [];
  for (const node of nodes) {
    if (node.flags.some((flag) => excluded.includes(flag))) continue;
    const parsed = parseNodeAddress(node.address);
    if (!parsed || addressKey(parsed.host, parsed.port) === seedKey) continue;
    desired.push({ ...parsed, nodeId: node.id, source: 'cluster', ...(node.hostname ? { hostname: node.hostname } : {}) });
  }
  return desired;
}

export function diffMembership(
  seedId: string,
  desired: DesiredNode[],
  current: MemberSnapshot[],
  lookup: AddressLookup,
): MembershipDiff {
  const diff: MembershipDiff = { add: [], adopt: [], reactivate: [], refresh: [], retire: [], skipped: [] };
  const currentByAddress = new Map(current.map((member) => [addressKey(member.host, member.port), member]));
  const desiredKeys = new Set<string>();

  const changed = (membership: TopologyMembership, node: DesiredNode): boolean =>
    membership.nodeId !== node.nodeId ||
    membership.source !== node.source ||
    membership.group !== node.group ||
    membership.role !== node.role ||
    membership.hostname !== node.hostname;

  for (const node of desired) {
    const key = addressKey(node.host, node.port);
    desiredKeys.add(key);
    const member = currentByAddress.get(key);
    if (member) {
      if (member.membership.retiredAt !== undefined) {
        const owner = lookup(node.host, node.port);
        if (owner && owner.id !== member.id) {
          diff.skipped.push({ host: node.host, port: node.port, reason: 'occupied' });
        } else {
          diff.reactivate.push({ id: member.id, node });
        }
      } else if (changed(member.membership, node)) {
        diff.refresh.push({ id: member.id, node });
      }
      continue;
    }
    const owner = lookup(node.host, node.port);
    if (!owner) {
      diff.add.push(node);
    } else if (owner.connectionType === 'external') {
      diff.skipped.push({ host: node.host, port: node.port, reason: 'external' });
    } else if (owner.membership && owner.membership.seedId !== seedId) {
      diff.skipped.push({ host: node.host, port: node.port, reason: 'claimed' });
    } else if (owner.isSeed) {
      diff.skipped.push({ host: node.host, port: node.port, reason: 'seed' });
    } else if (!owner.membership) {
      diff.adopt.push({ id: owner.id, node });
    }
  }

  for (const member of current) {
    if (member.membership.retiredAt === undefined && !desiredKeys.has(addressKey(member.host, member.port))) {
      diff.retire.push(member.id);
    }
  }
  return diff;
}

export function retirementKey(ids: string[]): string {
  return [...ids].sort().join(',');
}

export function exceedsRetirementThreshold(retiringAuto: number, activeAuto: number): boolean {
  return activeAuto > 0 && retiringAuto * 2 > activeAuto;
}
