import { ClusterNode } from '@app/common/types/metrics.types';

/**
 * Detects the stuck-cluster state behind valkey-io/valkey#2090: after a primary
 * is lost and replaced by a fresh node (e.g. a k8s pod restart brings the node
 * back at the same address but with a new node id and shard id), a surviving
 * replica keeps pointing at the *old* primary and never adopts the replacement.
 * The replica is orphaned — its primary is gone — and, without operator action
 * (`CLUSTER REPLICATE <new-primary-id>`), it stays that way indefinitely.
 *
 * The observable symptom in any single node's `CLUSTER NODES` view is a replica
 * whose `master` (the primary node id it replicates) resolves to a node that is
 * dead (`fail`/`fail?`/`noaddr`) or is absent from the view entirely. Note that
 * `CLUSTER NODES` does not expose shard ids (those live in `nodes.conf` /
 * `CLUSTER SHARDS`), so detection is based on the always-present flags + master
 * fields; a shard-id-aware refinement using `CLUSTER SHARDS` can layer on later.
 *
 * IMPORTANT — this is a *snapshot* detector. A brief window where a replica
 * still points at a just-failed primary is also normal during an ordinary
 * failover, before the replica is promoted or re-points. The caller MUST require
 * the same orphaned replica to persist across several polls (roughly ≥ the
 * cluster node timeout) before alerting, so a healthy failover never trips it.
 */

/** Flags that mark a primary as unusable (dead / unreachable / not yet gossiped). */
const DEAD_PRIMARY_FLAGS = ['fail', 'fail?', 'noaddr', 'handshake'];

export type StuckReplicaReason =
  /** The replica's primary is present in the view but flagged dead/unreachable. */
  | 'primary_failed'
  /** The replica's primary node id does not appear in the view at all. */
  | 'primary_unknown';

export interface StuckReplica {
  replicaId: string;
  replicaAddress: string;
  /** Node id the replica is trying to replicate (its `master`). */
  primaryId: string;
  /** Address of that primary if it is still present in the view, else null. */
  primaryAddress: string | null;
  reason: StuckReplicaReason;
}

/** A node is a replica if it carries the replica/slave flag and names a primary. */
function isReplica(node: ClusterNode): boolean {
  return (
    (node.flags.includes('slave') || node.flags.includes('replica')) &&
    !!node.master &&
    node.master !== '-'
  );
}

/** A primary is healthy (a valid replication target) if master-flagged and not dead. */
function isHealthyPrimary(node: ClusterNode): boolean {
  return (
    node.flags.includes('master') &&
    !DEAD_PRIMARY_FLAGS.some((flag) => node.flags.includes(flag))
  );
}

/**
 * Returns every replica whose primary is dead or missing from this `CLUSTER
 * NODES` view. Replicas with a healthy primary — the normal case — are ignored,
 * as are non-replica nodes. Callers should gate on persistence over time to
 * exclude the transient orphaned window of a normal failover (see file header).
 */
export function detectStuckReplicas(nodes: ClusterNode[]): StuckReplica[] {
  const byId = new Map<string, ClusterNode>();
  for (const node of nodes) {
    if (node.id) byId.set(node.id, node);
  }

  const stuck: StuckReplica[] = [];
  for (const replica of nodes) {
    if (!isReplica(replica)) continue;

    const primary = byId.get(replica.master);
    if (primary && isHealthyPrimary(primary)) continue; // normal: healthy primary

    stuck.push({
      replicaId: replica.id,
      replicaAddress: replica.address,
      primaryId: replica.master,
      primaryAddress: primary ? primary.address : null,
      reason: primary ? 'primary_failed' : 'primary_unknown',
    });
  }

  return stuck;
}

/**
 * Stable signature for a stuck replica, used to dedupe repeat alerts across
 * polls and to key the persistence gate. Keyed on the (replica, primary) pair so
 * a replica re-pointing at a new primary is treated as a distinct observation.
 */
export function stuckReplicaSignature(s: StuckReplica): string {
  return `${s.replicaId}|${s.primaryId}`;
}
