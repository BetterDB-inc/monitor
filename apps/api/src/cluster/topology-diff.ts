import { ClusterNode } from '../common/types/metrics.types';

/** The subset of a node's identity a failover can change. */
export interface TopologyNode {
  role: 'master' | 'replica';
  masterId?: string;
  configEpoch: number;
}

/** Per-connection topology, keyed by node id. */
export type TopologySnapshot = Map<string, TopologyNode>;

export type TopologyChangeReason = 'role_change' | 'primary_change' | 'epoch_bump';

export interface TopologyNodeChange {
  nodeId: string;
  reason: TopologyChangeReason;
  from: string;
  to: string;
}

export interface TopologyDiff {
  changed: boolean;
  reasons: TopologyChangeReason[];
  changedNodes: TopologyNodeChange[];
}

const NO_CHANGE: TopologyDiff = { changed: false, reasons: [], changedNodes: [] };

/**
 * Derive a node's role from its `CLUSTER NODES` flags. Returns null for an
 * entry that is neither, such as a handshake or noaddr placeholder, which has
 * no role to compare.
 */
export function roleFromFlags(flags: string[]): 'master' | 'replica' | null {
  if (flags.includes('master')) {
    return 'master';
  }
  if (flags.includes('slave') || flags.includes('replica')) {
    return 'replica';
  }
  return null;
}

/**
 * Takes the raw `CLUSTER NODES` reply rather than a `DiscoveredNode[]` so the
 * caller needs no dependency on ClusterDiscoveryService — and so detection runs
 * at the poll interval instead of the 30s discovery cache TTL.
 */
export function snapshotTopology(nodes: ClusterNode[]): TopologySnapshot {
  const snapshot: TopologySnapshot = new Map();
  for (const node of nodes) {
    const role = roleFromFlags(node.flags);
    if (role === null) {
      continue;
    }
    snapshot.set(node.id, {
      role,
      masterId: role === 'master' ? undefined : node.master,
      configEpoch: node.configEpoch,
    });
  }
  return snapshot;
}

/**
 * Compare two topology snapshots and report the transitions that mean a
 * failover happened, independent of `cluster_state`.
 *
 * A clean master-replica failover leaves `cluster_state:ok` and no failed
 * slots, so the CLUSTER INFO edge never fires for it — that is the common case
 * under load and during rolling upgrades (valkey#4340).
 *
 * Nodes that appear or disappear between snapshots are deliberately NOT a
 * failover: scaling and node loss are their own events, and reporting them here
 * would make every topology change look like a promotion.
 */
export function diffClusterTopology(
  previous: TopologySnapshot | null,
  current: TopologySnapshot,
): TopologyDiff {
  // No baseline yet — the first poll after process start. Every node would look
  // new, so a diff here would report a failover for each one on every restart.
  if (previous === null) {
    return NO_CHANGE;
  }

  const reasons = new Set<TopologyChangeReason>();
  const changedNodes: TopologyNodeChange[] = [];

  for (const [nodeId, after] of current) {
    const before = previous.get(nodeId);
    if (before === undefined) {
      continue;
    }

    if (before.role !== after.role) {
      reasons.add('role_change');
      changedNodes.push({
        nodeId,
        reason: 'role_change',
        from: before.role,
        to: after.role,
      });
      continue;
    }

    // Only meaningful while the role held steady: a replica that changed role
    // necessarily changed primary too, and reporting both double-counts one
    // event.
    if (after.role === 'replica' && before.masterId !== after.masterId) {
      reasons.add('primary_change');
      changedNodes.push({
        nodeId,
        reason: 'primary_change',
        from: before.masterId ?? 'none',
        to: after.masterId ?? 'none',
      });
      continue;
    }

    // Epochs only ever advance. A lower value is a stale or reordered read
    // rather than a failover, so only an increase counts.
    if (after.configEpoch > before.configEpoch) {
      reasons.add('epoch_bump');
      changedNodes.push({
        nodeId,
        reason: 'epoch_bump',
        from: String(before.configEpoch),
        to: String(after.configEpoch),
      });
    }
  }

  if (reasons.size === 0) {
    return NO_CHANGE;
  }

  return { changed: true, reasons: [...reasons], changedNodes };
}
