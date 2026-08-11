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
 * Inputs come from the polled node itself: its owned slot ranges and in-flight
 * migration markers (its own `CLUSTER NODES` line), per-slot key counts
 * (`CLUSTER SLOT-STATS`), and `DBSIZE`. Ownership is only meaningful on a
 * cluster primary — replicas mirror their primary's keyspace — so anything
 * else is a no-op.
 *
 * Two detection paths, because `CLUSTER SLOT-STATS` only reports slots
 * ASSIGNED to the node: (1) explicit — keyed slots outside the owned ranges,
 * for servers that do surface them (precise slot ids); (2) dbsize surplus —
 * `DBSIZE` counts every local key while SLOT-STATS sums only assigned slots,
 * so a surplus beyond a write-race floor is leaked keys the stats cannot see.
 *
 * IMPORTANT — this is a *snapshot* detector. Slots mid-reshard are excluded via
 * the migrating/importing markers, and the caller MUST additionally gate on
 * persistence across polls (see AnomalyService) so a reshard window whose
 * markers we missed between polls cannot false-positive.
 */

export interface OrphanedSlotKeysInput {
  /** Whether the connection is in cluster mode; standalone is a no-op. */
  clusterEnabled: boolean;
  /** Whether the polled node is a cluster primary; ownership is primary-scoped. */
  isClusterPrimary: boolean;
  /** Slot ranges the node owns, from its own CLUSTER NODES line ([[start, end], …]). */
  ownedSlots: number[][];
  /** Slots currently migrating away from this node (in-flight reshard). */
  migratingSlots: number[];
  /** Slots currently importing into this node (in-flight reshard). */
  importingSlots: number[];
  /** Per-slot stats from CLUSTER SLOT-STATS on this node. */
  slotStats: SlotStats;
  /** DBSIZE on this node for corroboration; null when unavailable. */
  dbsize: number | null;
}

export interface OrphanedSlot {
  slot: number;
  keyCount: number;
}

export const ORPHANED_DBSIZE_DELTA_MIN_KEYS = 100;

export interface OrphanedSlotKeysFinding {
  /**
   * How the leak was observed: 'slot_stats' = unowned keyed slots explicitly
   * reported (slot ids known); 'dbsize_delta' = keys exist that no reported
   * slot accounts for (slot ids unknown to SLOT-STATS).
   */
  reason: 'slot_stats' | 'dbsize_delta';
  /** Keyed slots outside the owned ranges, sorted by slot id; empty for 'dbsize_delta'. */
  orphanedSlots: OrphanedSlot[];
  totalOrphanedKeys: number;
  /**
   * dbsize minus the keys counted in reported OWNED slots — the number of
   * local keys living outside the owned ranges; null when dbsize unavailable.
   */
  dbsizeDelta: number | null;
}

function isSlotOwned(slot: number, ownedSlots: number[][]): boolean {
  return ownedSlots.some(([start, end]) => {
    return slot >= start && slot <= end;
  });
}

export function detectOrphanedSlotKeys(
  input: OrphanedSlotKeysInput,
): OrphanedSlotKeysFinding | null {
  if (input.clusterEnabled === false || input.isClusterPrimary === false) {
    return null;
  }

  const inFlight = new Set<number>([...input.migratingSlots, ...input.importingSlots]);

  const orphanedSlots: OrphanedSlot[] = [];
  let ownedKeys = 0;
  let totalReportedKeys = 0;
  for (const [slotLabel, stats] of Object.entries(input.slotStats)) {
    const slot = parseInt(slotLabel, 10);
    if (Number.isFinite(slot) === false || stats.key_count <= 0) {
      continue;
    }
    totalReportedKeys += stats.key_count;
    if (isSlotOwned(slot, input.ownedSlots)) {
      ownedKeys += stats.key_count;
      continue;
    }
    if (inFlight.has(slot)) {
      continue;
    }
    orphanedSlots.push({ slot, keyCount: stats.key_count });
  }

  if (orphanedSlots.length > 0) {
    orphanedSlots.sort((a, b) => {
      return a.slot - b.slot;
    });
    const totalOrphanedKeys = orphanedSlots.reduce((sum, entry) => {
      return sum + entry.keyCount;
    }, 0);
    return {
      reason: 'slot_stats',
      orphanedSlots,
      totalOrphanedKeys,
      dbsizeDelta: input.dbsize !== null ? input.dbsize - ownedKeys : null,
    };
  }

  // On a real server the explicit path stays empty: CLUSTER SLOT-STATS only
  // reports slots ASSIGNED to the node, so leaked keys are invisible to it.
  // They still count in dbsize — a persistent surplus of dbsize over every
  // reported slot's keys IS the leak. The floor absorbs the write-race noise
  // between the DBSIZE and SLOT-STATS reads.
  //
  // Suppressed while any slot is IMPORTING: arriving keys inflate dbsize
  // before their slot is assigned (and thus reported), so a live reshard
  // looks exactly like a leak until the handoff completes. MIGRATING slots
  // need no such suppression — a slot stays assigned (and counted) on this
  // node until its handoff.
  if (input.importingSlots.length > 0) {
    return null;
  }
  if (input.dbsize !== null) {
    const invisibleKeys = input.dbsize - totalReportedKeys;
    if (invisibleKeys >= ORPHANED_DBSIZE_DELTA_MIN_KEYS) {
      return {
        reason: 'dbsize_delta',
        orphanedSlots: [],
        totalOrphanedKeys: invisibleKeys,
        dbsizeDelta: invisibleKeys,
      };
    }
  }

  return null;
}

/**
 * Stable signature for dedupe across polls. Explicit findings key on the
 * orphaned slot SET, not the counts — the same leaked slots re-counted
 * (expiries, deletions) are the same condition, while a different set of
 * orphaned slots is a new observation. The dbsize-surplus signal has no slot
 * ids, so it keys on a constant: the surplus fluctuating does not re-alert.
 */
export function orphanedSlotKeysSignature(finding: OrphanedSlotKeysFinding): string {
  if (finding.reason === 'dbsize_delta') {
    return 'dbsize-delta';
  }
  return finding.orphanedSlots
    .map((entry) => {
      return entry.slot;
    })
    .join(',');
}
