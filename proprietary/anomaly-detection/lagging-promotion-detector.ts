/**
 * Detects the data-loss hazard behind valkey-io/valkey#2587: in a cluster-mode-
 * disabled (standalone) setup, `REPLICAOF NO ONE` promotes a replica to primary
 * with no coordination. If the promoted replica was lagging — a lower
 * replication offset than a sibling replica of the same primary — the extra
 * writes the sibling already had are lost, and that sibling is forced into a
 * full resync down to the new primary. A coordinated `FAILOVER` would have
 * caught the target up first; an uncoordinated `REPLICAOF NO ONE` does not.
 *
 * We can't add coordinated failover, but the hazard is observable: at the moment
 * a monitored node transitions slave→master, compare its replication offset to
 * the last-seen offset of its co-replica siblings (nodes sharing the same master
 * replication id). If a sibling was ahead, the promotion lost that sibling's
 * extra writes.
 *
 * This is a best-effort advisory: it needs the monitor to also see at least one
 * sibling replica of the same primary. With only the promoted node visible there
 * is nothing to compare against, so nothing fires.
 */

export interface ReplPeer {
  connectionId: string;
  name?: string;
  /** master_repl_offset: bytes consumed from the shared replication stream. */
  offset: number;
  role: 'master' | 'slave';
}

export interface LaggingPromotion {
  promotedId: string;
  promotedOffset: number;
  /** The most-advanced sibling replica at promotion time. */
  aheadId: string;
  aheadName?: string;
  aheadOffset: number;
  /** Bytes the promoted node was behind that sibling — writes now at risk of loss. */
  lagBytes: number;
}

/**
 * Returns the most-advanced co-replica sibling if it was ahead of the promoted
 * node by at least `minGapBytes`, else null.
 *
 * Only slave-role peers are considered: the former primary is always slightly
 * ahead of any replica (normal replication lag), so comparing against it would
 * false-positive on every healthy failover. Comparing replica-to-replica is
 * apples-to-apples — two replicas of the same primary tail the same stream and
 * sit at near-identical offsets, so a real gap means the wrong (more-behind)
 * replica was promoted. The gap in bytes is exactly the data the ahead replica
 * must discard when it full-resyncs down to the new primary.
 */
export function detectLaggingPromotion(
  promotedId: string,
  promotedOffset: number,
  peers: ReplPeer[],
  minGapBytes: number,
): LaggingPromotion | null {
  if (!Number.isFinite(promotedOffset)) return null;

  let ahead: ReplPeer | null = null;
  for (const peer of peers) {
    if (peer.connectionId === promotedId) continue;
    if (peer.role !== 'slave') continue;
    if (!Number.isFinite(peer.offset)) continue;
    if (ahead === null || peer.offset > ahead.offset) ahead = peer;
  }
  if (ahead === null) return null;

  const lagBytes = ahead.offset - promotedOffset;
  if (lagBytes < minGapBytes) return null;

  return {
    promotedId,
    promotedOffset,
    aheadId: ahead.connectionId,
    aheadName: ahead.name,
    aheadOffset: ahead.offset,
    lagBytes,
  };
}
