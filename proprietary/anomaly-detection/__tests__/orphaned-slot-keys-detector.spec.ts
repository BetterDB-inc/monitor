import { SlotStats } from '@app/common/types/metrics.types';
import {
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
    ownedSlots: [[0, 5460]],
    migratingSlots: [],
    importingSlots: [],
    slotStats: slotStats({ '100': 50, '2000': 10 }),
    dbsize: 60,
    ...over,
  };
}

describe('detectOrphanedSlotKeys', () => {
  it('flags keyed slots outside the owned ranges with per-slot counts and a total', () => {
    // Node owns 0-5460 but holds keys in 9000 and 12000 — the valkey#539
    // post-migration persistence-load leak: unreachable, memory-consuming keys.
    const finding = detectOrphanedSlotKeys(
      input({
        slotStats: slotStats({ '100': 50, '9000': 25, '12000': 5 }),
        dbsize: 80,
      }),
    );
    expect(finding).not.toBeNull();
    expect(finding!.orphanedSlots).toEqual([
      { slot: 9000, keyCount: 25 },
      { slot: 12000, keyCount: 5 },
    ]);
    expect(finding!.totalOrphanedKeys).toBe(30);
  });

  it('stays silent when every keyed slot is inside an owned range', () => {
    const finding = detectOrphanedSlotKeys(
      input({
        ownedSlots: [
          [0, 5460],
          [10000, 12000],
        ],
        slotStats: slotStats({ '0': 3, '5460': 7, '11000': 2 }),
      }),
    );
    expect(finding).toBeNull();
  });

  it('suppresses an unowned keyed slot that is currently importing (in-flight reshard)', () => {
    const finding = detectOrphanedSlotKeys(
      input({
        slotStats: slotStats({ '9000': 25 }),
        importingSlots: [9000],
      }),
    );
    expect(finding).toBeNull();
  });

  it('suppresses a keyed slot that is currently migrating away', () => {
    const finding = detectOrphanedSlotKeys(
      input({
        ownedSlots: [[0, 5460]],
        slotStats: slotStats({ '9000': 25 }),
        migratingSlots: [9000],
      }),
    );
    expect(finding).toBeNull();
  });

  it('is a no-op outside cluster mode', () => {
    const finding = detectOrphanedSlotKeys(
      input({ clusterEnabled: false, slotStats: slotStats({ '9000': 25 }) }),
    );
    expect(finding).toBeNull();
  });

  it('is a no-op on replicas (ownership is evaluated on primaries only)', () => {
    const finding = detectOrphanedSlotKeys(
      input({ isClusterPrimary: false, slotStats: slotStats({ '9000': 25 }) }),
    );
    expect(finding).toBeNull();
  });

  it('ignores unowned slots with zero keys', () => {
    const finding = detectOrphanedSlotKeys(input({ slotStats: slotStats({ '9000': 0 }) }));
    expect(finding).toBeNull();
  });

  it('corroborates against dbsize: the delta beyond owned-slot keys', () => {
    // Owned slots hold 50 keys, dbsize is 80 → 30 keys live outside owned
    // slots, matching the orphaned total.
    const finding = detectOrphanedSlotKeys(
      input({
        slotStats: slotStats({ '100': 50, '9000': 30 }),
        dbsize: 80,
      }),
    );
    expect(finding!.dbsizeDelta).toBe(30);
  });

  it('reports a null dbsize delta when dbsize is unavailable', () => {
    const finding = detectOrphanedSlotKeys(
      input({ slotStats: slotStats({ '9000': 30 }), dbsize: null }),
    );
    expect(finding!.dbsizeDelta).toBeNull();
  });
});

describe('orphanedSlotKeysSignature', () => {
  it('is stable while the same slots stay orphaned, regardless of key counts', () => {
    const a = detectOrphanedSlotKeys(input({ slotStats: slotStats({ '9000': 25, '12000': 5 }) }));
    const b = detectOrphanedSlotKeys(input({ slotStats: slotStats({ '9000': 999, '12000': 1 }) }));
    expect(orphanedSlotKeysSignature(a!)).toBe(orphanedSlotKeysSignature(b!));
  });

  it('changes when the orphaned slot set changes', () => {
    const a = detectOrphanedSlotKeys(input({ slotStats: slotStats({ '9000': 25 }) }));
    const b = detectOrphanedSlotKeys(input({ slotStats: slotStats({ '9000': 25, '12000': 5 }) }));
    expect(orphanedSlotKeysSignature(a!)).not.toBe(orphanedSlotKeysSignature(b!));
  });
});
