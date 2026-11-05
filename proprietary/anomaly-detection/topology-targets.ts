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

export type RegisteredAddress = (host: string, port: number, nodeId?: string) => boolean;

export interface TopologyScope {
  targets: TopologyTarget[];
  members: Set<string>;
}

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

export function clusterTargets(nodes: ClusterNode[], isRegistered: RegisteredAddress): TopologyScope {
  const targets = new Map<string, TopologyTarget>();
  const down = new Set<string>();
  for (const node of nodes) {
    if (!node.flags.includes('master') || node.flags.includes('myself')) continue;
    const address = splitHostPort(node.address);
    if (!address || isRegistered(address.host, address.port, node.id)) continue;
    const addr = `${address.host}:${address.port}`;
    if (UNREACHABLE_CLUSTER_FLAGS.some((flag) => node.flags.includes(flag))) {
      down.add(addr);
      continue;
    }
    if (!targets.has(addr)) targets.set(addr, { addr, ...address, nodeId: node.id });
  }
  return scopeOf(targets, down);
}

export function sentinelTargets(
  masters: SentinelNodeInfo[],
  isRegistered: RegisteredAddress,
): TopologyScope {
  const targets = new Map<string, TopologyTarget>();
  const down = new Set<string>();
  for (const master of masters) {
    if (!master.ip || !Number.isInteger(master.port) || master.port <= 0) continue;
    if (isRegistered(master.ip, master.port)) continue;
    const addr = `${master.ip}:${master.port}`;
    if (UNREACHABLE_SENTINEL_FLAGS.some((flag) => master.flags.includes(flag))) {
      down.add(addr);
      continue;
    }
    if (!targets.has(addr)) {
      targets.set(addr, { addr, host: master.ip, port: master.port });
    }
  }
  return scopeOf(targets, down);
}

function scopeOf(reachable: Map<string, TopologyTarget>, down: Set<string>): TopologyScope {
  const targets = [...reachable.values()].sort((a, b) => a.addr.localeCompare(b.addr));
  const unreachable = [...down].filter((addr) => !reachable.has(addr));
  return { targets, members: new Set([...targets.map((t) => t.addr), ...unreachable]) };
}

export class TopologyTargetClaims {
  private owners = new Map<string, { connectionId: string; at: number }>();

  claim(
    connectionId: string,
    targets: TopologyTarget[],
    now: number,
    staleMs: number,
    limit = TOPOLOGY_TARGET_LIMIT,
  ): TopologyTarget[] {
    const free = targets.filter((target) => !this.heldByOther(connectionId, target.addr, now, staleMs));
    const claimed = free.slice(0, limit);
    const wanted = new Set(claimed.map((t) => t.addr));
    for (const [addr, owner] of this.owners) {
      if (owner.connectionId === connectionId && !wanted.has(addr)) this.owners.delete(addr);
    }
    for (const target of claimed) this.owners.set(target.addr, { connectionId, at: now });
    return claimed;
  }

  heldByOther(connectionId: string, addr: string, now: number, staleMs: number): boolean {
    const owner = this.owners.get(addr);
    return !!owner && owner.connectionId !== connectionId && now - owner.at <= staleMs;
  }

  releaseTarget(connectionId: string, addr: string): void {
    if (this.owners.get(addr)?.connectionId === connectionId) this.owners.delete(addr);
  }

  release(connectionId: string): void {
    for (const [addr, owner] of this.owners) {
      if (owner.connectionId === connectionId) this.owners.delete(addr);
    }
  }
}
