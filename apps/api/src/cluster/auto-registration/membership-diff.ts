import type { TopologyMembership } from '@betterdb/shared';
import type { DiscoveredNode } from '../cluster-discovery.service';

export interface DesiredNode {
  host: string;
  port: number;
  nodeId: string;
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
  adopt: Array<{ id: string; nodeId: string }>;
  reactivate: Array<{ id: string; nodeId: string }>;
  refreshNodeId: Array<{ id: string; nodeId: string }>;
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

export function desiredFromDiscovery(seed: { host: string; port: number }, nodes: DiscoveredNode[]): DesiredNode[] {
  const seedKey = addressKey(seed.host, seed.port);
  const desired: DesiredNode[] = [];
  for (const node of nodes) {
    if (node.flags.some((flag) => EXCLUDED_FLAGS.includes(flag))) continue;
    const parsed = parseNodeAddress(node.address);
    if (!parsed || addressKey(parsed.host, parsed.port) === seedKey) continue;
    desired.push({ ...parsed, nodeId: node.id });
  }
  return desired;
}

export function diffMembership(
  seedId: string,
  desired: DesiredNode[],
  current: MemberSnapshot[],
  lookup: AddressLookup,
): MembershipDiff {
  const diff: MembershipDiff = { add: [], adopt: [], reactivate: [], refreshNodeId: [], retire: [], skipped: [] };
  const currentByAddress = new Map(current.map((member) => [addressKey(member.host, member.port), member]));
  const desiredKeys = new Set<string>();

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
          diff.reactivate.push({ id: member.id, nodeId: node.nodeId });
        }
      } else if (member.membership.nodeId !== node.nodeId) {
        diff.refreshNodeId.push({ id: member.id, nodeId: node.nodeId });
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
      diff.adopt.push({ id: owner.id, nodeId: node.nodeId });
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
