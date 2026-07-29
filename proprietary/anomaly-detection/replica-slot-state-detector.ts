import { ClusterNode, ClusterShard } from '@app/common/types/metrics.types';

/**
 * Detects the stuck, inconsistent slot state behind valkey-io/valkey#1664: after
 * slots are migrated between primaries, some *replicas* start reporting slots in
 * `migrating`/`importing` state (or otherwise owning slots) in `CLUSTER NODES`.
 * A replica should never carry slot-migration state — it is node-local
 * bookkeeping for the primary performing the reshard. The replica gets stuck in
 * this state and does not self-heal; the only known recovery is an operator
 * running `CLUSTER SETSLOT <slot> STABLE` on the affected node. Upstream wants
 * the engine to auto-heal (rooted in the #445 consistency/availability
 * trade-off); until then the condition is silent.
 *
 * Detection has two layers:
 *
 *  - Layer 1 (`CLUSTER NODES` only): a replica-flagged node carrying a non-empty
 *    `migratingSlots`/`importingSlots`. This is the primary, unambiguous signal
 *    and needs no extra data — the parser already extracts those fields.
 *
 *  - Layer 2 (`CLUSTER SHARDS` cross-view refinement, when `shards` is passed):
 *      1. Role authority — `CLUSTER SHARDS` reports each node's authoritative
 *         role. If it says the node is a `master`, the node is mid-promotion (its
 *         `CLUSTER NODES` replica flag is briefly stale) and may legitimately
 *         hold migration state, so we SUPPRESS the alert. Only nodes that SHARDS
 *         also considers a replica (or that are absent from the shard view) are
 *         reported.
 *      2. Shard attribution — the affected shard (its master id + authoritative
 *         slot ranges) is attached so an operator can target the fix.
 *      3. Slot-view divergence — a replica that *owns* slots in `CLUSTER NODES`
 *         (replicas never list slots there) is a further inconsistency the shard
 *         authority exposes, caught even without an explicit migrating/importing
 *         marker.
 *
 * IMPORTANT — this is a *snapshot* detector. A brief window where a node still
 * shows transient slot state during an ordinary reshard/failover is normal. The
 * caller MUST require the same anomaly signature to persist across several polls
 * before alerting (see the persistence gate in AnomalyService), so a healthy
 * reshard never trips it.
 */

export type ReplicaSlotReason =
  /** Replica is reporting a slot in `migrating` state (`[slot->-nodeid]`). */
  | 'replica_migrating'
  /** Replica is reporting a slot in `importing` state (`[slot-<-nodeid]`). */
  | 'replica_importing'
  /** Replica owns slots in `CLUSTER NODES` that diverge from the shard authority. */
  | 'slot_view_divergence';

export interface ReplicaSlotAnomaly {
  replicaId: string;
  replicaAddress: string;
  reason: ReplicaSlotReason;
  /**
   * The slots implicated, sorted ascending. For migrating/importing these are the
   * individual stuck slot numbers. For `slot_view_divergence` these are the
   * distinct bounds (start AND end) of each owned range, so that a change in the
   * owned range — not just its start — yields a distinct signature (see
   * `replicaSlotSignature`).
   */
  affectedSlots: number[];
  /**
   * For `slot_view_divergence`: the actual owned slot ranges (`[[start,end],…]`)
   * the replica reports in CLUSTER NODES, for human-readable rendering.
   */
  ownedSlots?: number[][];
  /** Master node id of the shard this node belongs to, if known from CLUSTER SHARDS. */
  shardId?: string;
  /** Authoritative slot ranges owned by that shard, if known from CLUSTER SHARDS. */
  shardSlots?: number[][];
}

/** A node is a replica if it carries the replica/slave flag. */
function isReplica(node: ClusterNode): boolean {
  return node.flags.includes('slave') || node.flags.includes('replica');
}

interface ShardInfo {
  shardId: string;
  shardSlots: number[][];
}

/**
 * Index `CLUSTER SHARDS` by node id → authoritative role and owning-shard info.
 * The shard is identified by its master node's id (CLUSTER SHARDS has no
 * explicit shard id), falling back to the first node's id.
 */
function indexShards(shards: ClusterShard[]): {
  roleByNode: Map<string, string>;
  shardByNode: Map<string, ShardInfo>;
} {
  const roleByNode = new Map<string, string>();
  const shardByNode = new Map<string, ShardInfo>();

  for (const shard of shards) {
    const master = shard.nodes.find((n) => n.role === 'master') ?? shard.nodes[0];
    const shardId = master?.id ?? '';
    for (const n of shard.nodes) {
      roleByNode.set(n.id, n.role);
      shardByNode.set(n.id, { shardId, shardSlots: shard.slots });
    }
  }

  return { roleByNode, shardByNode };
}

/**
 * Returns every replica that is wrongly reporting slot state. Layer 1 runs on
 * `CLUSTER NODES` alone; passing `shards` enables the Layer 2 role-authority
 * suppression, shard attribution, and slot-view-divergence checks. Callers
 * should gate on persistence over time to exclude the transient window of a
 * normal reshard (see file header).
 */
export function detectReplicaSlotState(
  nodes: ClusterNode[],
  shards?: ClusterShard[],
): ReplicaSlotAnomaly[] {
  const hasShards = Array.isArray(shards) && shards.length > 0;
  const { roleByNode, shardByNode } = hasShards
    ? indexShards(shards as ClusterShard[])
    : { roleByNode: new Map<string, string>(), shardByNode: new Map<string, ShardInfo>() };

  const anomalies: ReplicaSlotAnomaly[] = [];

  for (const node of nodes) {
    if (!isReplica(node)) continue;

    // Role authority: if SHARDS says this node is actually a master, it is
    // mid-promotion — its replica flag is stale and slot state is legitimate.
    if (hasShards && roleByNode.get(node.id) === 'master') continue;

    const shardInfo = shardByNode.get(node.id);
    const attribution = shardInfo
      ? { shardId: shardInfo.shardId, shardSlots: shardInfo.shardSlots }
      : {};

    if (node.migratingSlots && node.migratingSlots.length > 0) {
      anomalies.push({
        replicaId: node.id,
        replicaAddress: node.address,
        reason: 'replica_migrating',
        affectedSlots: sortedUnique(node.migratingSlots.map((m) => m.slot)),
        ...attribution,
      });
    }

    if (node.importingSlots && node.importingSlots.length > 0) {
      anomalies.push({
        replicaId: node.id,
        replicaAddress: node.address,
        reason: 'replica_importing',
        affectedSlots: sortedUnique(node.importingSlots.map((m) => m.slot)),
        ...attribution,
      });
    }

    // Divergence: a replica owning slots in CLUSTER NODES is inconsistent with
    // the shard authority. This is a FALLBACK signal — only raised when the
    // replica has no explicit migrating/importing markers, so a single stuck
    // replica never yields two anomalies with contradictory remediation (a
    // migration alert says "run SETSLOT ... STABLE"; divergence says not to).
    // Only meaningful with the shard cross-view, so gate on `hasShards`.
    // Signature on the distinct bounds of each owned range so a range that
    // grows/shrinks (even keeping its start) re-signatures and re-alerts; keep
    // the raw ranges for the message.
    const hasMigrationMarkers =
      (node.migratingSlots?.length ?? 0) > 0 || (node.importingSlots?.length ?? 0) > 0;
    if (hasShards && !hasMigrationMarkers && node.slots.length > 0) {
      anomalies.push({
        replicaId: node.id,
        replicaAddress: node.address,
        reason: 'slot_view_divergence',
        affectedSlots: sortedUnique(node.slots.flatMap((range) => range)),
        ownedSlots: node.slots,
        ...attribution,
      });
    }
  }

  return anomalies;
}

function sortedUnique(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

/**
 * Stable signature for a replica slot-state anomaly, used to dedupe repeat
 * alerts across polls and to key the persistence gate. Keyed on the replica, the
 * reason, and the implicated slots so a change in which slots are stuck is
 * treated as a distinct observation.
 */
export function replicaSlotSignature(a: ReplicaSlotAnomaly): string {
  return `${a.replicaId}|${a.reason}|${a.affectedSlots.join(',')}`;
}
