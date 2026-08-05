import { ClusterNode } from '@app/common/types/metrics.types';

/**
 * Detects the asymmetric-membership fault behind valkey-io/valkey#1757:
 * "CLUSTER RESET forgets other nodes, but they don't forget you."
 *
 * A `CLUSTER RESET` (or a plain restart that re-provisions the node's identity)
 * wipes the resetting node's own view of the cluster, but the *other* nodes keep
 * it. On a HARD reset the node comes back with a brand-new node-id + fresh
 * `configEpoch 0`, while its *old* node-id lingers in every peer's table as
 * `fail`/`fail?`/`noaddr` — the peers never got a `CLUSTER FORGET`. The result,
 * readable from any single node's `CLUSTER NODES` view, is a **ghost**: one
 * `ip:port` endpoint claimed by two distinct node-ids — a stale dead identity
 * remembered alongside the live one that actually occupies the endpoint now.
 *
 * The upstream fix (broadcast a FORGET on reset) is unresolved and lives in the
 * engine. We can't fix it, but we can surface the residue and tell the operator
 * exactly which stale id to `CLUSTER FORGET` to clear it.
 *
 * This is the stateless, high-precision Layer 1 of the detector: it fires only on
 * the persistent stale-twin signature (a ghost id + a live twin on the same
 * endpoint). The transient ~15s re-MEET/handshake churn window described in the
 * issue is left to a future stateful Layer 2 — it self-heals and would be noisy
 * without a time window.
 */

export interface GhostMember {
  /** Canonical `ip:port` (cluster-bus `@cport` stripped) that two node-ids disagree over. */
  endpoint: string;
  /**
   * Stale node-ids still remembered at this endpoint — the `CLUSTER FORGET`
   * targets. Sorted for a stable signature.
   */
  ghostIds: string[];
  /** Node-id that actually occupies the endpoint now (the live/incoming twin). */
  liveId: string;
  /** Flags on the live occupant, for message context (e.g. whether it's still handshaking). */
  liveFlags: string[];
}

/**
 * Flags marking a node-id as a *ghost*: a dead-but-remembered identity that a
 * peer never forgot. These are exactly the ids a `CLUSTER FORGET` clears.
 * `handshake` is deliberately NOT here — a handshaking line is the node *joining*
 * (the live/incoming side), not the stale id to evict.
 */
const GHOST_FLAGS = ['fail', 'fail?', 'noaddr'];

function isGhost(node: ClusterNode): boolean {
  return GHOST_FLAGS.some((flag) => node.flags.includes(flag));
}

/**
 * Canonical `ip:port` for a node, with the cluster-bus `@cport` suffix stripped.
 * Returns '' for an address with no host (a `noaddr`/`:0` line), so those never
 * group together into a spurious endpoint collision.
 *
 * The host is everything before the *last* colon (the port separator), so a
 * compressed IPv6 address whose own colons — including a leading `::` — are part
 * of the host is still recognised as having a host rather than being dropped.
 */
export function canonicalEndpoint(address: string): string {
  const hostPort = (address ?? '').split('@')[0];
  const portColon = hostPort.lastIndexOf(':');
  const host = portColon === -1 ? hostPort : hostPort.slice(0, portColon);
  return host ? hostPort : '';
}

/**
 * Finds every endpoint claimed by more than one node-id where at least one id is
 * a ghost (`fail`/`fail?`/`noaddr`) and at least one *other* id is live — i.e. a
 * stale identity lingering next to the node that actually occupies the endpoint.
 *
 * A single-id endpoint (the normal case, including a node that briefly failed and
 * recovered under its *same* id), and an endpoint whose ids are *all* ghosts (a
 * fully-dead node with no live twin — a different, failover-level concern) are
 * both ignored, so only the true identity-reuse ghost trips detection.
 */
export function detectGhostMembers(nodes: ClusterNode[]): GhostMember[] {
  const byEndpoint = new Map<string, ClusterNode[]>();
  for (const node of nodes) {
    const endpoint = canonicalEndpoint(node.address);
    if (!endpoint) continue;
    const list = byEndpoint.get(endpoint) ?? [];
    list.push(node);
    byEndpoint.set(endpoint, list);
  }

  const findings: GhostMember[] = [];
  for (const [endpoint, group] of byEndpoint) {
    const distinctIds = new Set(group.map((n) => n.id));
    if (distinctIds.size < 2) continue;

    const ghosts = group.filter(isGhost);
    const nonGhosts = group.filter((n) => !isGhost(n));
    if (ghosts.length === 0 || nonGhosts.length === 0) continue;

    // The live twin is whatever occupies the endpoint now: prefer an established
    // node, but fall back to a still-handshaking one (a HARD-reset re-join caught
    // mid-handshake, its old id already flagged fail).
    const established = nonGhosts.find((n) => !n.flags.includes('handshake'));
    const live = established ?? nonGhosts[0];

    const ghostIds = [...new Set(ghosts.map((g) => g.id))]
      .filter((id) => id !== live.id)
      .sort();
    if (ghostIds.length === 0) continue;

    findings.push({
      endpoint,
      ghostIds,
      liveId: live.id,
      liveFlags: live.flags,
    });
  }

  return findings;
}

/**
 * Stable signature for a ghost finding, used to dedupe repeat alerts across polls
 * and to restart the persistence grace window when the occupant changes.
 */
export function ghostMemberSignature(g: GhostMember): string {
  return `${g.endpoint}|${[g.liveId, ...g.ghostIds].sort().join(',')}`;
}
