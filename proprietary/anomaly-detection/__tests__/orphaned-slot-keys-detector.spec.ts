import { SlotStats } from '@app/common/types/metrics.types';
import {
  ORPHANED_DBSIZE_DELTA_MIN_KEYS,
  OrphanedSlotKeysInput,
  detectOrphanedSlotKeys,
  orphanedSlotKeysSignature,
} from '../orphaned-slot-keys-detector';

function slotStats(entries: Record<string, number>): SlotStats {
  const stats: SlotStats = {};
  for (const [slot, keyCount] of Object.entries(entries)) {
    stats[slot] = { key_count: keyCount, expires_count: 0, total_reads: 0, total_writes: 0 };
  }
  return stats;
}

function input(over: Partial<OrphanedSlotKeysInput> = {}): OrphanedSlotKeysInput {
  return {
    clusterEnabled: true,
    isClusterPrimary: true,
    importingSlots: [],
    slotStats: slotStats({ '100': 50, '2000': 10 }),
    dbsize: 60,
    ...over,
  };
}

describe('detectOrphanedSlotKeys', () => {
  it('fires on a dbsize surplus over every slot SLOT-STATS reports', () => {
    // The valkey#539 leak as it actually presents: SLOT-STATS reports only the
    // node's assigned slots, so the leaked keys show up purely as dbsize
    // counting more than every reported slot accounts for.
    const finding = detectOrphanedSlotKeys(
      input({
        slotStats: slotStats({ '100': 50, '2000': 10 }),
        dbsize: 60 + ORPHANED_DBSIZE_DELTA_MIN_KEYS,
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding?.totalOrphanedKeys).toBe(ORPHANED_DBSIZE_DELTA_MIN_KEYS);
  });

  it('stays silent when dbsize matches the counted keys', () => {
    expect(detectOrphanedSlotKeys(input({ dbsize: 60 }))).toBeNull();
  });

  it('stays silent on a surplus below the floor', () => {
    const finding = detectOrphanedSlotKeys(
      input({ dbsize: 60 + ORPHANED_DBSIZE_DELTA_MIN_KEYS - 1 }),
    );
    expect(finding).toBeNull();
  });

  it('stays silent when dbsize is unavailable', () => {
    expect(detectOrphanedSlotKeys(input({ dbsize: null }))).toBeNull();
  });

  it('suppresses the surplus while an import is in flight', () => {
    // Arriving keys inflate dbsize before their slot is assigned and reported,
    // so a live reshard is indistinguishable from a leak.
    const finding = detectOrphanedSlotKeys(
      input({ dbsize: 60 + ORPHANED_DBSIZE_DELTA_MIN_KEYS, importingSlots: [9000] }),
    );
    expect(finding).toBeNull();
  });

  it('is a no-op outside cluster mode', () => {
    const finding = detectOrphanedSlotKeys(
      input({ clusterEnabled: false, dbsize: 60 + ORPHANED_DBSIZE_DELTA_MIN_KEYS }),
    );
    expect(finding).toBeNull();
  });

  it('is a no-op on replicas (ownership is evaluated on primaries only)', () => {
    const finding = detectOrphanedSlotKeys(
      input({ isClusterPrimary: false, dbsize: 60 + ORPHANED_DBSIZE_DELTA_MIN_KEYS }),
    );
    expect(finding).toBeNull();
  });

  it('ignores reported slots with zero keys', () => {
    const finding = detectOrphanedSlotKeys(
      input({ slotStats: slotStats({ '100': 50, '2000': 10, '3000': 0 }), dbsize: 60 }),
    );
    expect(finding).toBeNull();
  });

  // ── Churn cannot manufacture a surplus ────────────────────────────────────
  // The caller passes the LOWEST dbsize seen either side of the SLOT-STATS
  // read. With owned-slot keys O and leaked keys L, the surplus is
  // min(O(t0), O(t2)) + L - O(t1) — at most L for any monotone change in O.
  describe('conservatism under concurrent churn (low-water dbsize)', () => {
    it('does not fire on a delete/expiry-heavy keyspace with no leak', () => {
      // A TTL cache draining: 10_000 keys at the first dbsize read, 9_000 by
      // the SLOT-STATS read, 8_500 by the second. The naive single-read form
      // would report a 1_000-key surplus every poll on a healthy cache.
      const naiveSurplus = 10_000 - 9_000;
      expect(naiveSurplus).toBeGreaterThan(ORPHANED_DBSIZE_DELTA_MIN_KEYS);

      const finding = detectOrphanedSlotKeys(
        input({
          slotStats: slotStats({ '100': 9_000 }),
          dbsize: Math.min(10_000, 8_500),
        }),
      );
      expect(finding).toBeNull();
    });

    it('does not fire on an insert-heavy keyspace with no leak', () => {
      const finding = detectOrphanedSlotKeys(
        input({
          slotStats: slotStats({ '100': 9_000 }),
          dbsize: Math.min(8_000, 10_000),
        }),
      );
      expect(finding).toBeNull();
    });

    it('still reports a genuine leak while the keyspace drains around it', () => {
      // 500 leaked keys, invisible to SLOT-STATS, while owned keys fall
      // 10_000 → 9_800 → 9_600 across the three reads.
      const leaked = 500;
      const finding = detectOrphanedSlotKeys(
        input({
          slotStats: slotStats({ '100': 9_800 }),
          dbsize: Math.min(10_000 + leaked, 9_600 + leaked),
        }),
      );
      expect(finding).not.toBeNull();
      // Conservative: never more than the true leak.
      expect(finding?.totalOrphanedKeys).toBeLessThanOrEqual(leaked);
    });

    it('reports the leak exactly on a steady keyspace', () => {
      const leaked = 640;
      const finding = detectOrphanedSlotKeys(
        input({ slotStats: slotStats({ '100': 9_000 }), dbsize: 9_000 + leaked }),
      );
      expect(finding?.totalOrphanedKeys).toBe(leaked);
    });
  });
});

describe('orphanedSlotKeysSignature', () => {
  it('is stable while the surplus fluctuates, so a leak alerts once', () => {
    expect(orphanedSlotKeysSignature({ totalOrphanedKeys: 500 })).toBe(
      orphanedSlotKeysSignature({ totalOrphanedKeys: 512 }),
    );
  });
});
