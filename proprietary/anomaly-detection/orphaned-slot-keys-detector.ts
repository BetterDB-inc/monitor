import { SlotStats } from '@app/common/types/metrics.types';

/**
 * Detects orphaned keys in unowned cluster slots (valkey-io/valkey#539): when a
 * node loads an RDB/AOF file whose keyspace includes slots it no longer owns
 * (a persistence file that predates a slot migration, or a warm-up reusing a
 * shared RDB), the engine loads every key regardless of ownership. Keys in
 * unowned slots are permanently unreachable — clients get routed to the slot's
 * actual owner — yet they count in `dbsize` and hold memory. Upstream treats
 * the missing cleanup as effectively a bugfix but has not shipped it, so the
 * hazard is durable and worth surfacing.
 *
 * The signal is the DBSIZE surplus, and it is the ONLY signal, because
 * `CLUSTER SLOT-STATS` reports exclusively slots the node is assigned.
 * Verified on Valkey 8.1.6: with 5 keys resident in a slot the node does not
 * own, `CLUSTER SLOT-STATS SLOTSRANGE 941 941` returns empty and the slot is
 * absent from `ORDERBY key-count`, while `CLUSTER COUNTKEYSINSLOT 941` still
 * reports 5 — both when the slot is unassigned cluster-wide and when another
 * node owns it. So leaked keys are invisible to SLOT-STATS by construction,
 * and the surplus of DBSIZE over every reported slot IS the leak.
 *
 * Ownership is only meaningful on a cluster primary — replicas mirror their
 * primary's keyspace — so anything else is a no-op.
 *
 * IMPORTANT — this is a *snapshot* detector. The caller MUST gate on
 * persistence across polls (see AnomalyService) so a reshard window whose
 * transient markers fell between two polls cannot false-positive.
 */

export interface OrphanedSlotKeysInput {
  /** Whether the connection is in cluster mode; standalone is a no-op. */
  clusterEnabled: boolean;
  /** Whether the polled node is a cluster primary; ownership is primary-scoped. */
  isClusterPrimary: boolean;
  /** Slots currently importing into this node (in-flight reshard). */
  importingSlots: number[];
  /** Per-slot stats from CLUSTER SLOT-STATS on this node. */
  slotStats: SlotStats;
  /**
   * The LOWEST DBSIZE observed across reads taken either side of the
   * SLOT-STATS read, or null when unavailable. Taking the low-water mark is
   * what makes the surplus conservative under concurrent churn — see
   * `detectOrphanedSlotKeys`.
   */
  dbsize: number | null;
}

/**
 * Floor the surplus must clear before it counts as a leak. With a low-water
 * DBSIZE the surplus can no longer be manufactured by monotone churn, so this
 * only has to absorb non-monotone interleavings (a keyspace that dips and
 * recovers between the bracketing reads), which are bounded by the few
 * milliseconds between round trips.
 */
export const ORPHANED_DBSIZE_DELTA_MIN_KEYS = 100;

export interface OrphanedSlotKeysFinding {
  /**
   * Keys DBSIZE counts that no reported slot accounts for. SLOT-STATS cannot
   * name the slots they live in, so the count is all the evidence there is.
   */
  totalOrphanedKeys: number;
}

/**
 * A leak shows up as DBSIZE persistently exceeding the keys in every slot
 * SLOT-STATS reports.
 *
 * The subtlety is that DBSIZE and SLOT-STATS are two round trips, so the
 * keyspace can move between them. Reading DBSIZE either side of SLOT-STATS and
 * passing the LOWER of the two makes the surplus conservative in both
 * directions: with owned-slot keys `O(t)` and leaked keys `L`, the surplus is
 * `min(O(t0), O(t2)) + L - O(t1)`, which for any monotone change in `O` is at
 * most `L` — deletions and expiries can no longer inflate it, and inserts
 * cannot either. A steady keyspace yields exactly `L`.
 *
 * That matters because the naive form (a single DBSIZE read before SLOT-STATS)
 * is biased POSITIVE by deletes: a key counted by DBSIZE but expired before the
 * SLOT-STATS read reads as leaked. On a high-churn TTL cache that bias recurs
 * every poll, which — since the signature is constant — is exactly what the
 * persistence gate would confirm as a leak.
 *
 * Suppressed while any slot is IMPORTING: arriving keys inflate dbsize before
 * their slot is assigned (and thus reported), so a live reshard looks like a
 * leak until the handoff completes. NB the caller must treat an import in
 * flight as an OBSERVATION GAP (skip its persistence gate entirely, as
 * AnomalyService does) — feeding this null into the gate would read as
 * recovery and flap an already-alerted leak. MIGRATING slots need no special
 * case: a slot stays assigned (and counted) on this node until its handoff,
 * and the key deletions that migration performs only move the surplus DOWN
 * under the low-water rule.
 */
export function detectOrphanedSlotKeys(
  input: OrphanedSlotKeysInput,
): OrphanedSlotKeysFinding | null {
  if (input.clusterEnabled === false || input.isClusterPrimary === false) {
    return null;
  }
  if (input.importingSlots.length > 0) {
    return null;
  }
  if (input.dbsize === null) {
    return null;
  }

  let totalReportedKeys = 0;
  for (const [slotLabel, stats] of Object.entries(input.slotStats)) {
    const slot = parseInt(slotLabel, 10);
    if (Number.isFinite(slot) === false || stats.key_count <= 0) {
      continue;
    }
    totalReportedKeys += stats.key_count;
  }

  const invisibleKeys = input.dbsize - totalReportedKeys;
  if (invisibleKeys < ORPHANED_DBSIZE_DELTA_MIN_KEYS) {
    return null;
  }
  return { totalOrphanedKeys: invisibleKeys };
}

/**
 * Stable signature for dedupe across polls. The surplus carries no slot ids —
 * SLOT-STATS cannot see the leaked slots — so there is exactly one condition to
 * key on, and a fluctuating surplus must not re-alert.
 */
export function orphanedSlotKeysSignature(_finding: OrphanedSlotKeysFinding): string {
  return 'dbsize-delta';
}
