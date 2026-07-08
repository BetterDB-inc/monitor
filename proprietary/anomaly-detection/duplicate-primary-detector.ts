import { ClusterNode } from '@app/common/types/metrics.types';

/**
 * Detects the topology fault behind valkey-io/valkey#2261: a single slot (hash
 * slot range) claimed by more than one primary at the same time — i.e. two
 * primaries in one shard.
 *
 * From any single node's `CLUSTER NODES` view the unambiguous symptom is a slot
 * range owned by two master-flagged nodes. The master with the *lower*
 * `configEpoch` is the stale/phantom primary — exactly the node Valkey's own
 * proposed fix demotes to a replica.
 *
 * This is topology-level detection: we cannot fix the server-side consensus bug,
 * but we can alert the operator the moment the cluster enters the invalid state.
 */

export interface ConflictingPrimary {
  id: string;
  address: string;
  configEpoch: number;
}

export interface DuplicatePrimaryConflict {
  /** First overlapping slot range shared by the two primaries. */
  slotStart: number;
  slotEnd: number;
  /** The two primaries claiming the overlapping slots (ordered by configEpoch, highest first). */
  masters: [ConflictingPrimary, ConflictingPrimary];
  /** Node id of the suspected phantom primary — the one with the lower configEpoch. */
  phantomId: string;
}

/**
 * Returns the first overlapping slot range between two sets of slot ranges, or
 * null if they are disjoint. Each range is an inclusive `[start, end]` pair.
 */
export function firstOverlappingRange(
  a: number[][],
  b: number[][],
): [number, number] | null {
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (start <= end) {
        return [start, end];
      }
    }
  }
  return null;
}

/**
 * Transient/unhealthy CLUSTER NODES flags. A node carrying any of these is not a
 * stable live primary, so it must not count toward a slot-overlap conflict:
 * during a normal failover the old primary briefly shows as `master,fail` (or
 * `master,fail?`) while still listing its slots, and the just-promoted replica
 * lists the same slots as `master`. Counting both as live would fire a false
 * split-brain CRITICAL on healthy recovery. `handshake`/`noaddr` nodes are not
 * fully known to the gossip layer yet.
 */
const UNHEALTHY_PRIMARY_FLAGS = ['fail', 'fail?', 'handshake', 'noaddr'];

/** A node is a live primary only if it's master-flagged, owns slots, and is not transient/unhealthy. */
function isLivePrimary(node: ClusterNode): boolean {
  return (
    node.flags.includes('master') &&
    node.slots.length > 0 &&
    !UNHEALTHY_PRIMARY_FLAGS.some((flag) => node.flags.includes(flag))
  );
}

/**
 * Finds every pair of primaries that claim overlapping slots. Replicas (nodes
 * not flagged `master`), masters that own no slots, and masters in a transient
 * or unhealthy state (`fail`/`fail?`/`handshake`/`noaddr`) are ignored, so a
 * healthy primary + its replicas — and a normal failover — never trip detection.
 */
export function detectDuplicatePrimaries(
  nodes: ClusterNode[],
): DuplicatePrimaryConflict[] {
  const masters = nodes.filter(isLivePrimary);

  const conflicts: DuplicatePrimaryConflict[] = [];

  for (let i = 0; i < masters.length; i++) {
    for (let j = i + 1; j < masters.length; j++) {
      const overlap = firstOverlappingRange(masters[i].slots, masters[j].slots);
      if (!overlap) continue;

      // Order the pair so the higher-epoch (authoritative) primary is first.
      const pair = [masters[i], masters[j]].sort(
        (x, y) => y.configEpoch - x.configEpoch,
      );
      const [authoritative, phantom] = pair;

      conflicts.push({
        slotStart: overlap[0],
        slotEnd: overlap[1],
        masters: [
          {
            id: authoritative.id,
            address: authoritative.address,
            configEpoch: authoritative.configEpoch,
          },
          {
            id: phantom.id,
            address: phantom.address,
            configEpoch: phantom.configEpoch,
          },
        ],
        phantomId: phantom.id,
      });
    }
  }

  return conflicts;
}

/**
 * Stable signature for a conflict, used to dedupe repeat alerts across polls.
 * Independent of which primary is listed first and of the exact overlap range.
 */
export function conflictSignature(conflict: DuplicatePrimaryConflict): string {
  return conflict.masters
    .map((m) => m.id)
    .sort()
    .join('|');
}
