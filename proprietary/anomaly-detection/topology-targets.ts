import type { ClusterNode, SentinelNodeInfo } from '@app/common/types/metrics.types';

export const TOPOLOGY_TARGET_LIMIT = 64;

const UNREACHABLE_CLUSTER_FLAGS = ['fail', 'fail?', 'noaddr', 'handshake'];
const UNREACHABLE_SENTINEL_FLAGS = ['s_down', 'o_down', 'disconnected'];

export interface TopologyTarget {
  addr: string;
  host: string;
  port: number;
  nodeId?: string;
}

export type RegisteredAddress = (host: string, port: number) => boolean;

export function topologyStateKey(connectionId: string, addr: string): string {
  return `${connectionId}@${addr}`;
}

export function connectionOfStateKey(key: string): string {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

export function isTopologyStateKeyOf(key: string, connectionId: string): boolean {
  return key === connectionId || key.startsWith(`${connectionId}@`);
}

export function splitHostPort(addr: string): { host: string; port: number } | null {
  const bare = addr.split('@')[0];
  const colon = bare.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = bare.slice(0, colon).replace(/^\[(.*)\]$/, '$1');
  const port = Number(bare.slice(colon + 1));
  if (!host || !Number.isInteger(port) || port <= 0) return null;
  return { host, port };
}

export function clusterTargets(
  nodes: ClusterNode[],
  isRegistered: RegisteredAddress,
): TopologyTarget[] {
  const targets: TopologyTarget[] = [];
  for (const node of nodes) {
    if (!node.flags.includes('master') || node.flags.includes('myself')) continue;
    if (UNREACHABLE_CLUSTER_FLAGS.some((flag) => node.flags.includes(flag))) continue;
    const address = splitHostPort(node.address);
    if (!address || isRegistered(address.host, address.port)) continue;
    targets.push({ addr: `${address.host}:${address.port}`, ...address, nodeId: node.id });
  }
  return capTargets(targets);
}

export function sentinelTargets(
  masters: SentinelNodeInfo[],
  isRegistered: RegisteredAddress,
): TopologyTarget[] {
  const targets = new Map<string, TopologyTarget>();
  for (const master of masters) {
    if (!master.ip || !Number.isInteger(master.port) || master.port <= 0) continue;
    if (UNREACHABLE_SENTINEL_FLAGS.some((flag) => master.flags.includes(flag))) continue;
    if (isRegistered(master.ip, master.port)) continue;
    const addr = `${master.ip}:${master.port}`;
    if (!targets.has(addr)) {
      targets.set(addr, { addr, host: master.ip, port: master.port });
    }
  }
  return capTargets([...targets.values()]);
}

function capTargets(targets: TopologyTarget[]): TopologyTarget[] {
  return targets
    .sort((a, b) => a.addr.localeCompare(b.addr))
    .slice(0, TOPOLOGY_TARGET_LIMIT);
}
