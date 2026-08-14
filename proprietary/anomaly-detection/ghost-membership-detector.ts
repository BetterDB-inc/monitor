import { ClusterNode } from '@app/common/types/metrics.types';

/**
 * Detects endpoint-identity faults readable from a single node's `CLUSTER NODES`
 * view. Three distinct upstream faults share one signature family — an `ip:port`
 * endpoint that does not map cleanly to exactly one healthy node-id — so they are
 * reported under one metric with a `reason` discriminator.
 *
 * `stale_twin` (valkey-io/valkey#1757) — "CLUSTER RESET forgets other nodes, but
 * they don't forget you." A `CLUSTER RESET` (or a plain restart that re-provisions
 * the node's identity) wipes the resetting node's own view of the cluster, but the
 * *other* nodes keep it. On a HARD reset the node comes back with a brand-new
 * node-id + fresh `configEpoch 0`, while its *old* node-id lingers in every peer's
 * table as `fail`/`fail?`/`noaddr` — the peers never got a `CLUSTER FORGET`. The
 * result is a **ghost**: one endpoint claimed by two distinct node-ids, a stale
 * dead identity remembered alongside the live one that occupies the endpoint now.
 *
 * `live_endpoint_collision` (valkey-io/valkey#2768) — the same endpoint claimed by
 * two or more distinct ids where **both twins are live**. Under CPU steal or
 * scheduling starvation a node's address discovery picks up the wrong address and
 * gossips it, so two healthy nodes advertise one endpoint. Failover then cannot
 * select a correct primary, replicas try to `PSYNC` to themselves, and clients are
 * routed to the wrong node. The dead-twin logic above explicitly excludes this
 * case (it requires one twin to be a ghost), which is why it needs its own reason.
 *
 * `loopback_flip` (valkey-io/valkey#2768, severe variant) — the address a node
 * mis-discovered is a loopback/localhost address while its peers use routable
 * ones. This is the smoking gun for the same fault, and it is reported separately
 * because it is unambiguous and unrecoverable without operator action
 * (`cluster-announce-ip`). A cluster where *every* node is on loopback is a normal
 * local development topology and is never flagged.
 *
 * The upstream fixes live in the engine and are unresolved. We can't fix them, but
 * we can surface the residue and tell the operator exactly what to do about it.
 *
 * This is the stateless, high-precision Layer 1 of the detector: it fires only on
 * signatures visible in a single snapshot. The transient ~15s re-MEET/handshake
 * churn window, and the FORGET-then-rejoin case that needs membership history, are
 * left to the stateful Layer 2 — they self-heal or need memory, and would be noisy
 * here.
 */

/** Which endpoint-identity fault a finding describes. */
export type GhostReason = 'stale_twin' | 'live_endpoint_collision' | 'loopback_flip';

export interface GhostMember {
  /** Which fault this finding describes — drives severity and advice. */
  reason: GhostReason;
  /** Canonical `ip:port` (cluster-bus `@cport` stripped) the node-ids disagree over. */
  endpoint: string;
  /**
   * Stale node-ids still remembered at this endpoint — the `CLUSTER FORGET`
   * targets. Populated for `stale_twin` only; empty for the live-twin reasons,
   * where no id is safe to forget. Sorted for a stable signature.
   */
  ghostIds: string[];
  /** Node-id that actually occupies the endpoint now (the live/incoming twin). */
  liveId: string;
  /** Flags on the live occupant, for message context (e.g. whether it's still handshaking). */
  liveFlags: string[];
  /**
   * Every distinct LIVE id sharing this endpoint. Populated for the live-twin
   * reasons — these are the ids in conflict, none of which is stale. Sorted.
   */
  collidingIds: string[];
  /**
   * Ids in this finding whose `master` points at their own node-id — a replica of
   * itself. Corroborates the address-mis-discovery fault. Sorted.
   */
  selfReplicatingIds: string[];
  /**
   * The subset of ids the signature is built from: established members only,
   * never a still-handshaking twin. A re-MEET churning through `handshake` on the
   * same endpoint would otherwise rewrite the signature every poll, dropping the
   * finding out of the persistence map and restarting its grace window — which
   * would delay or suppress an alert that is continuously present. Sorted.
   */
  stableIds: string[];
}

/**
 * Flags marking a node-id as a *ghost*: a dead-but-remembered identity that a
 * peer never forgot. These are exactly the ids a `CLUSTER FORGET` clears.
 * `handshake` is deliberately NOT here — a handshaking line is the node *joining*
 * (the live/incoming side), not the stale id to evict.
 */
const GHOST_FLAGS = ['fail', 'fail?', 'noaddr'];

function isGhost(node: ClusterNode): boolean {
  return GHOST_FLAGS.some((flag) => {
    return node.flags.includes(flag);
  });
}

/**
 * A node that has completed the join handshake. Handshaking ids are live but not
 * yet established, so they never count toward an endpoint *collision* — a node
 * re-MEETing an endpoint it is about to occupy is the normal rejoin path, not two
 * nodes fighting over one address.
 */
function isEstablished(node: ClusterNode): boolean {
  if (isGhost(node)) {
    return false;
  }
  return !node.flags.includes('handshake');
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

/** Host portion of a canonical `ip:port`, with any IPv6 brackets stripped. */
export function endpointHost(endpoint: string): string {
  const portColon = endpoint.lastIndexOf(':');
  const host = portColon === -1 ? endpoint : endpoint.slice(0, portColon);
  return host.replace(/^\[/, '').replace(/\]$/, '');
}

/**
 * Whether a host is a loopback/localhost address — the address a node
 * mis-discovers when its own address detection fails (valkey#2768). Covers the
 * whole 127.0.0.0/8 range, not just 127.0.0.1.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  return /^127\./.test(normalized);
}

/**
 * The id that occupies an endpoint now: prefer an established node, but fall back
 * to a still-handshaking one (a HARD-reset re-join caught mid-handshake, its old
 * id already flagged fail).
 */
function preferredOccupant(live: ClusterNode[]): ClusterNode {
  // Sorted first: CLUSTER NODES ordering is not guaranteed stable between polls,
  // and the occupant id feeds the signature — picking by input order would let an
  // identical snapshot produce a different signature and restart the grace window.
  const sorted = [...live].sort((a, b) => {
    return a.id.localeCompare(b.id);
  });
  const established = sorted.find((n) => {
    return isEstablished(n);
  });
  return established ?? sorted[0];
}

function sortedDistinctIds(nodes: ClusterNode[]): string[] {
  return [
    ...new Set(
      nodes.map((n) => {
        return n.id;
      }),
    ),
  ].sort();
}

/**
 * Finds every endpoint whose node-ids do not resolve to exactly one healthy
 * identity:
 *
 * - a stale ghost id (`fail`/`fail?`/`noaddr`) lingering next to the live id that
 *   actually occupies the endpoint (`stale_twin`),
 * - two or more established ids claiming one endpoint (`live_endpoint_collision`),
 * - a node advertising loopback while its peers are routable (`loopback_flip`),
 *   which supersedes the plain collision reason since it names the root cause.
 *
 * A single-id endpoint (the normal case, including a node that briefly failed and
 * recovered under its *same* id), and an endpoint whose ids are *all* ghosts (a
 * fully-dead node with no live twin — a different, failover-level concern) are
 * both ignored.
 */
export function detectGhostMembers(nodes: ClusterNode[]): GhostMember[] {
  const byEndpoint = new Map<string, ClusterNode[]>();
  for (const node of nodes) {
    const endpoint = canonicalEndpoint(node.address);
    if (!endpoint) {
      continue;
    }
    const list = byEndpoint.get(endpoint) ?? [];
    list.push(node);
    byEndpoint.set(endpoint, list);
  }

  const selfReplicating = new Set(
    nodes
      .filter((n) => {
        return n.master !== '' && n.master !== '-' && n.master === n.id;
      })
      .map((n) => {
        return n.id;
      }),
  );

  // A loopback endpoint is only suspicious when it is the ODD ONE OUT: the fault
  // is one node losing its address announcement while its peers keep theirs.
  //
  // Two things this guards against. Ghost ids are excluded, so a single dead
  // `fail`/`noaddr` record carrying a routable address cannot make an otherwise
  // all-loopback dev cluster look mixed. And routable members must OUTNUMBER
  // loopback ones, so a mostly-local cluster that gains one routable node does
  // not report every healthy loopback node as flipped. A tie is ambiguous —
  // neither side is clearly the anomaly — and stays silent.
  //
  // Only ESTABLISHED members are counted. A handshaking twin appearing on the
  // flipped endpoint during a re-MEET would otherwise tip the balance and make an
  // ongoing CRITICAL vanish for the duration of the handshake.
  const liveHosts = nodes
    .filter((n) => {
      return isEstablished(n);
    })
    .map((n) => {
      return canonicalEndpoint(n.address);
    })
    .filter((endpoint) => {
      return endpoint !== '';
    })
    .map((endpoint) => {
      return endpointHost(endpoint);
    });
  const loopbackHosts = liveHosts.filter((host) => {
    return isLoopbackHost(host);
  }).length;
  const loopbackIsOddOneOut = liveHosts.length - loopbackHosts > loopbackHosts;

  const selfReplicatingAmong = (ids: string[]): string[] => {
    return ids
      .filter((id) => {
        return selfReplicating.has(id);
      })
      .sort();
  };

  const findings: GhostMember[] = [];
  for (const [endpoint, group] of byEndpoint) {
    const ghosts = group.filter((n) => {
      return isGhost(n);
    });
    const live = group.filter((n) => {
      return !isGhost(n);
    });
    const established = group.filter((n) => {
      return isEstablished(n);
    });

    const isLoopbackFlip =
      loopbackIsOddOneOut && isLoopbackHost(endpointHost(endpoint)) && live.length > 0;

    if (isLoopbackFlip) {
      const occupant = preferredOccupant(live);
      const collidingIds = sortedDistinctIds(live);
      const establishedIds = sortedDistinctIds(established);
      findings.push({
        reason: 'loopback_flip',
        endpoint,
        ghostIds: [],
        liveId: occupant.id,
        liveFlags: occupant.flags,
        collidingIds,
        stableIds: establishedIds.length > 0 ? establishedIds : [occupant.id],
        selfReplicatingIds: selfReplicatingAmong(collidingIds),
      });
    } else if (sortedDistinctIds(established).length >= 2) {
      const occupant = preferredOccupant(established);
      const collidingIds = sortedDistinctIds(established);
      findings.push({
        reason: 'live_endpoint_collision',
        endpoint,
        ghostIds: [],
        liveId: occupant.id,
        liveFlags: occupant.flags,
        collidingIds,
        stableIds: collidingIds,
        selfReplicatingIds: selfReplicatingAmong(collidingIds),
      });
    }

    // The dead-twin path is evaluated independently: a ghost id at an endpoint
    // that ALSO has colliding live twins is two separate faults, and the FORGET
    // advice stands regardless of the collision.
    if (ghosts.length === 0 || live.length === 0) {
      continue;
    }
    const occupant = preferredOccupant(live);
    const ghostIds = sortedDistinctIds(ghosts).filter((id) => {
      return id !== occupant.id;
    });
    if (ghostIds.length === 0) {
      continue;
    }

    findings.push({
      reason: 'stale_twin',
      endpoint,
      ghostIds,
      liveId: occupant.id,
      liveFlags: occupant.flags,
      collidingIds: [],
      stableIds: [occupant.id, ...ghostIds].sort(),
      selfReplicatingIds: selfReplicatingAmong([occupant.id, ...ghostIds]),
    });
  }

  return findings;
}

/**
 * Stable signature for a finding, used to dedupe repeat alerts across polls and to
 * restart the persistence grace window when the occupant changes. The reason is
 * part of the signature so a stale twin and a live collision at the same endpoint
 * cannot dedupe each other out.
 */
export function ghostMemberSignature(g: GhostMember): string {
  return `${g.reason}|${g.endpoint}|${[...g.stableIds].sort().join(',')}`;
}
