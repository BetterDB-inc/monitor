import { ClusterNode, ClusterShard } from '@app/common/types/metrics.types';

/**
 * Detects the topology fault behind valkey-io/valkey#304: hostname gossip in a
 * Valkey Cluster converges *eventually*, not atomically. Immediately after a
 * node (re)joins, or while `cluster-announce-hostname` is being rolled out, a
 * node can advertise a raw IP with NO hostname while its peers already carry
 * one, and `CLUSTER NODES` (per-node gossip view) can disagree with
 * `CLUSTER SHARDS` (the shard-grouped, more authoritative endpoint view) about
 * the same node's hostname/endpoint. Either state breaks TLS-SNI hostname
 * verification and can make a client key the node by the wrong endpoint.
 *
 * Upstream has indicated this is likely won't-fix (gossip convergence is
 * fundamental to the design), so detection lives here: we cannot fix the
 * engine, but we can advise the operator the moment a node's hostname info is
 * missing or inconsistent.
 *
 * From a single node's `CLUSTER NODES` view (plus, optionally, `CLUSTER
 * SHARDS`) there are two observable symptoms:
 *
 *  1. `missing_hostname` — a node advertises an IP with no hostname while
 *     OTHER nodes in the same view DO carry one. Mixed availability within a
 *     single gossip snapshot means this node's hostname simply hasn't
 *     propagated yet (as opposed to a cluster that doesn't use hostnames at
 *     all, where every node lacks one — that is not flagged).
 *  2. `hostname_mismatch` — `CLUSTER NODES` and `CLUSTER SHARDS` both carry a
 *     hostname for the same node id but they DISAGREE. We compare hostname to
 *     hostname only: `CLUSTER SHARDS`'s `endpoint` field follows
 *     `cluster-preferred-endpoint-type` (default `ip`), so it is usually the raw
 *     IP even on a cluster that announces hostnames — comparing a NODES hostname
 *     against that endpoint would false-positive on every healthy hostname
 *     cluster. A hostname present in one view but absent in the other is
 *     convergence lag (covered by Reason 1 / self-heals), not a hard mismatch.
 *
 * IMPORTANT — this is a *snapshot* detector. Gossip convergence after a node
 * joins, restarts, or has its `cluster-announce-hostname` changed is normal
 * and self-heals within roughly a cluster-node-timeout window. The caller MUST
 * require the same finding to persist across several polls before alerting,
 * so a healthy convergence window never trips it.
 */

export type HostnameStalenessReason =
  /** This node has no hostname while at least one peer in the same view does. */
  | 'missing_hostname'
  /** This node's CLUSTER NODES hostname disagrees with its CLUSTER SHARDS hostname (both present). */
  | 'hostname_mismatch';

export interface HostnameStaleness {
  nodeId: string;
  /** `ip:port@cport` from CLUSTER NODES. */
  address: string;
  reason: HostnameStalenessReason;
  /** Hostname carried on this node's own CLUSTER NODES line, if any. */
  nodesHostname?: string;
  /** Hostname reported for this same node id in CLUSTER SHARDS, when both views carry one. */
  shardsHostname?: string;
}

/**
 * Flags marking a node whose hostname state is not a live, actionable signal:
 * `handshake`/`noaddr` haven't settled their identity yet, and `fail`/`fail?`
 * are dead — a dead node isn't serving TLS-SNI traffic, so its hostname is
 * irrelevant. Counting a failed node would both make the cluster look
 * hostname-enabled (flagging every live node that lacks one) and keep alerting
 * on the dead node itself, and neither warning can self-heal. Matches the
 * duplicate-primary detector's live-node filter.
 */
const NON_LIVE_FLAGS = ['handshake', 'noaddr', 'fail', 'fail?'];

function isLiveNode(node: ClusterNode): boolean {
  return !!node.id && !NON_LIVE_FLAGS.some((flag) => node.flags.includes(flag));
}

/**
 * Returns every node whose hostname info is missing (while peers have one) or
 * disagrees with `CLUSTER SHARDS`. Non-live nodes (`handshake`/`noaddr` not yet
 * settled, or `fail`/`fail?` dead) are excluded — an unsettled or dead node's
 * hostname is not an actionable live-routing signal, and counting a failed node
 * would falsely make the cluster look hostname-enabled (or keep alerting on the
 * dead node forever). Callers should gate on persistence over time to exclude
 * the transient convergence window of a normal join/restart (see file header).
 */
export function detectHostnameStaleness(
  nodes: ClusterNode[],
  shards?: ClusterShard[],
): HostnameStaleness[] {
  const known = nodes.filter(isLiveNode);
  if (known.length === 0) return [];

  const findings: HostnameStaleness[] = [];

  // Reason 1: mixed hostname availability within this single view. Only
  // meaningful when at least one node in the view DOES carry a hostname —
  // otherwise hostnames simply aren't in use on this cluster.
  const anyHostnamePresent = known.some((n) => !!n.hostname);
  if (anyHostnamePresent) {
    for (const n of known) {
      if (!n.hostname) {
        findings.push({ nodeId: n.id, address: n.address, reason: 'missing_hostname' });
      }
    }
  }

  // Reason 2: CLUSTER NODES vs CLUSTER SHARDS hostname disagreement. Compare
  // hostname-to-hostname ONLY. CLUSTER SHARDS's `endpoint` follows
  // `cluster-preferred-endpoint-type` (default `ip`), so on a healthy cluster
  // that announces hostnames the SHARDS endpoint is the raw IP while CLUSTER
  // NODES carries the hostname — comparing hostname-to-endpoint would flag that
  // normal steady state forever. Fire only when BOTH views carry a hostname for
  // the node and they differ; a present-vs-absent hostname is convergence lag
  // (Reason 1 / self-heals), not a hard mismatch.
  if (shards && shards.length > 0) {
    const shardHostnameById = new Map<string, string>();
    for (const shard of shards) {
      for (const shardNode of shard.nodes) {
        if (shardNode.hostname) shardHostnameById.set(shardNode.id, shardNode.hostname);
      }
    }

    for (const n of known) {
      const shardsHostname = shardHostnameById.get(n.id);
      if (!n.hostname || !shardsHostname) continue; // one side omits a hostname — convergence lag, not a mismatch
      if (n.hostname !== shardsHostname) {
        findings.push({
          nodeId: n.id,
          address: n.address,
          reason: 'hostname_mismatch',
          nodesHostname: n.hostname,
          shardsHostname,
        });
      }
    }
  }

  return findings;
}

/**
 * Stable signature for a finding, used to dedupe repeat alerts across polls
 * and to key the persistence gate. Keyed on (node, reason) so a node that is
 * both missing a hostname AND mismatched against CLUSTER SHARDS is tracked as
 * two distinct, independently-resolving observations.
 */
export function hostnameStalenessSignature(finding: HostnameStaleness): string {
  return `${finding.nodeId}|${finding.reason}`;
}
