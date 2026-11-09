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

interface TargetOwner {
  connectionId: string;
  at: number;
  down: boolean;
  /** The one connection reading a down-held primary until it confirms or lets go. */
  takeover?: { connectionId: string; at: number };
}

export class TopologyTargetClaims {
  private owners = new Map<string, TargetOwner>();

  /**
   * Claims up to `limit` free targets, and every free `down` address: a
   * primary the topology flags as down is not read, but whoever holds it is
   * the one connection that counts it unreachable. A primary held only as
   * down is free to a connection whose topology still reaches it (`fail?` and
   * `s_down` are one seed's view), so that connection reads it instead. The
   * down claim stays until that read succeeds (`confirm`), so a takeover whose
   * read fails or backs off does not hand the primary back and forth. The
   * takeover is reserved for one connection at a time, until it confirms or
   * lets the primary go. Returns the claimed targets.
   */
  claim(
    connectionId: string,
    targets: TopologyTarget[],
    now: number,
    staleMs: number,
    limit = TOPOLOGY_TARGET_LIMIT,
    down: Iterable<string> = [],
  ): TopologyTarget[] {
    const free = targets.filter((target) => this.isFreeFor(connectionId, target.addr, now, staleMs));
    const claimed = free.slice(0, limit);
    const freeDown = [...down].filter((addr) => !this.heldByOther(connectionId, addr, now, staleMs));
    const takeovers = new Set<string>();
    const wanted = new Map<string, boolean>(freeDown.map((addr): [string, boolean] => [addr, true]));
    for (const t of claimed) {
      if (this.heldByOther(connectionId, t.addr, now, staleMs)) takeovers.add(t.addr);
      else wanted.set(t.addr, false);
    }
    for (const [addr, owner] of this.owners) {
      if (owner.connectionId === connectionId && !wanted.has(addr)) this.owners.delete(addr);
      else if (owner.takeover?.connectionId === connectionId && !takeovers.has(addr)) delete owner.takeover;
    }
    for (const [addr, isDown] of wanted) {
      const previous = this.owners.get(addr);
      const takeover = isDown && previous?.connectionId === connectionId ? previous.takeover : undefined;
      this.owners.set(addr, { connectionId, at: now, down: isDown, takeover });
    }
    for (const addr of takeovers) this.owners.get(addr)!.takeover = { connectionId, at: now };
    return claimed;
  }

  /**
   * Takes over a primary claimed from a down holder once it was read, unless
   * the reservation was lost in the meantime: another connection took it, or
   * the holder claimed it as reachable again. Returns whether it took it.
   */
  confirm(connectionId: string, addr: string, now: number): boolean {
    const owner = this.owners.get(addr);
    if (owner && owner.connectionId !== connectionId && owner.takeover?.connectionId !== connectionId) return false;
    this.owners.set(addr, { connectionId, at: now, down: false });
    return true;
  }

  /**
   * Whether the connection may read the primary: no one else holds it, or
   * only as down with no other connection already taking it over.
   */
  isFreeFor(connectionId: string, addr: string, now: number, staleMs: number): boolean {
    const owner = this.otherOwner(connectionId, addr, now, staleMs);
    if (!owner) return true;
    if (!owner.down) return false;
    const takeover = owner.takeover;
    return !takeover || takeover.connectionId === connectionId || now - takeover.at > staleMs;
  }

  heldByOther(connectionId: string, addr: string, now: number, staleMs: number): boolean {
    return this.otherOwner(connectionId, addr, now, staleMs) !== undefined;
  }

  private otherOwner(connectionId: string, addr: string, now: number, staleMs: number) {
    const owner = this.owners.get(addr);
    return owner && owner.connectionId !== connectionId && now - owner.at <= staleMs ? owner : undefined;
  }

  releaseTarget(connectionId: string, addr: string): void {
    const owner = this.owners.get(addr);
    if (owner?.connectionId === connectionId) this.owners.delete(addr);
    else if (owner?.takeover?.connectionId === connectionId) delete owner.takeover;
  }

  release(connectionId: string): void {
    for (const [addr, owner] of this.owners) {
      if (owner.connectionId === connectionId) this.owners.delete(addr);
      else if (owner.takeover?.connectionId === connectionId) delete owner.takeover;
    }
  }
}
