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
 *  2. `endpoint_mismatch` — a node's hostname/address in `CLUSTER NODES`
 *     disagrees with the endpoint reported for the same node id in `CLUSTER
 *     SHARDS`. `CLUSTER SHARDS`'s `endpoint` field is the hostname when one is
 *     announced, else the raw IP — so this fires when the two views genuinely
 *     disagree about the same node's identity, not merely because one of the
 *     two omits a hostname.
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
  /** This node's CLUSTER NODES hostname (or IP, if it has none) disagrees with its CLUSTER SHARDS endpoint. */
  | 'endpoint_mismatch';

export interface HostnameStaleness {
  nodeId: string;
  /** `ip:port@cport` from CLUSTER NODES. */
  address: string;
  reason: HostnameStalenessReason;
  /** Hostname carried on this node's own CLUSTER NODES line, if any. */
  nodesHostname?: string;
  /** Endpoint reported for this same node id in CLUSTER SHARDS, when available. */
  shardsEndpoint?: string;
}

/** Flags marking a node not yet fully known to the gossip layer — its identity fields aren't reliable yet. */
const UNRELIABLE_FLAGS = ['handshake', 'noaddr'];

function isKnownNode(node: ClusterNode): boolean {
  return !!node.id && !UNRELIABLE_FLAGS.some((flag) => node.flags.includes(flag));
}

/** Strips the cluster-bus port (and any trailing hostname, already split by the parser) to the bare `ip`. */
function ipFromAddress(address: string): string {
  const withoutCport = address.split('@')[0] ?? '';
  const idx = withoutCport.lastIndexOf(':');
  return idx === -1 ? withoutCport : withoutCport.slice(0, idx);
}

/**
 * Returns every node whose hostname info is missing (while peers have one) or
 * disagrees with `CLUSTER SHARDS`. Nodes not yet known to the gossip layer
 * (`handshake`/`noaddr`) are excluded — their identity fields aren't settled
 * yet, so including them would just restate the same eventual-consistency
 * window this detector is meant to filter out. Callers should gate on
 * persistence over time to exclude the transient convergence window of a
 * normal join/restart (see file header).
 */
export function detectHostnameStaleness(
  nodes: ClusterNode[],
  shards?: ClusterShard[],
): HostnameStaleness[] {
  const known = nodes.filter(isKnownNode);
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

  // Reason 2: CLUSTER NODES vs CLUSTER SHARDS endpoint disagreement.
  if (shards && shards.length > 0) {
    const shardEndpointById = new Map<string, string>();
    for (const shard of shards) {
      for (const shardNode of shard.nodes) {
        if (shardNode.endpoint) shardEndpointById.set(shardNode.id, shardNode.endpoint);
      }
    }

    for (const n of known) {
      const shardsEndpoint = shardEndpointById.get(n.id);
      if (!shardsEndpoint) continue; // node absent from CLUSTER SHARDS this poll — nothing to compare

      const expected = n.hostname || ipFromAddress(n.address);
      if (expected && shardsEndpoint !== expected) {
        findings.push({
          nodeId: n.id,
          address: n.address,
          reason: 'endpoint_mismatch',
          nodesHostname: n.hostname,
          shardsEndpoint,
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
