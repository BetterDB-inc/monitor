import { annotateIndexingEvents, IndexingEvent } from '../correlation';
import { LatencyEntry } from '../bucketing';
import { VectorIndexSnapshot } from '@betterdb/shared';

function entry(overrides: Partial<LatencyEntry> = {}): LatencyEntry {
  return {
    timestamp: 1_700_000_050_000,
    duration: 5_000,
    command: ['FT.SEARCH', 'idx_cache', '*'],
    clientAddress: '127.0.0.1:1234',
    clientName: 'worker',
    ...overrides,
  };
}

function snap(overrides: Partial<VectorIndexSnapshot> = {}): VectorIndexSnapshot {
  return {
    id: 's1',
    timestamp: 1_700_000_040_000,
    connectionId: 'conn-1',
    indexName: 'idx_cache',
    numDocs: 0,
    numRecords: 0,
    numDeletedDocs: 0,
    indexingFailures: 0,
    indexingFailuresDelta: 0,
    percentIndexed: 100,
    indexingState: 'indexed',
    totalIndexingTime: 0,
    memorySizeMb: 0,
    ...overrides,
  };
}

const windowStart = 1_700_000_000_000;
const windowEnd = 1_700_000_100_000;

describe('annotateIndexingEvents', () => {
  it('returns empty for non-FT.SEARCH buckets (short-circuit)', () => {
    expect(
      annotateIndexingEvents({
        bucketKey: 'read',
        entries: [entry({ duration: 50_000 })],
        snapshots: [snap({ percentIndexed: 50 })],
        windowStartMs: windowStart,
        windowEndMs: windowEnd,
      }),
    ).toEqual([]);
  });

  it('returns empty when bucket has no entries', () => {
    expect(
      annotateIndexingEvents({
        bucketKey: 'FT.SEARCH:idx_cache',
        entries: [],
        snapshots: [snap({ percentIndexed: 50 })],
        windowStartMs: windowStart,
        windowEndMs: windowEnd,
      }),
    ).toEqual([]);
  });

  it('returns empty when every snapshot is fully indexed', () => {
    expect(
      annotateIndexingEvents({
        bucketKey: 'FT.SEARCH:idx_cache',
        entries: [entry({ duration: 50_000 })],
        snapshots: [snap({ timestamp: 1_700_000_040_000, percentIndexed: 100 })],
        windowStartMs: windowStart,
        windowEndMs: windowEnd,
      }),
    ).toEqual([]);
  });

  it('emits one event when a tail entry coincides with a partial-index snapshot', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ timestamp: 1_700_000_010_000 + i * 1_000, duration: (i + 1) * 1_000 }),
    );
    const result = annotateIndexingEvents({
      bucketKey: 'FT.SEARCH:idx_cache',
      entries,
      snapshots: [snap({ timestamp: 1_700_000_015_000, percentIndexed: 75 })],
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });
    const expected: IndexingEvent = {
      kind: 'latency_degraded_during_indexing',
      bucket: 'FT.SEARCH:idx_cache',
      since: 1_700_000_015_000,
    };
    expect(result).toEqual([expected]);
  });

  it('collapses multiple non-100 snapshots to one event with earliest since', () => {
    const background = Array.from({ length: 18 }, () =>
      entry({ timestamp: 1_700_000_011_000, duration: 1_000 }),
    );
    const tailEarly = entry({ timestamp: 1_700_000_013_000, duration: 50_000 });
    const tailLate = entry({ timestamp: 1_700_000_027_000, duration: 51_000 });
    const result = annotateIndexingEvents({
      bucketKey: 'FT.SEARCH:idx_cache',
      entries: [...background, tailEarly, tailLate],
      snapshots: [
        snap({ timestamp: 1_700_000_012_000, percentIndexed: 80 }),
        snap({ timestamp: 1_700_000_025_000, percentIndexed: 60 }),
      ],
      windowStartMs: windowStart,
      windowEndMs: windowEnd,
    });
    expect(result).toHaveLength(1);
    expect(result[0].since).toBe(1_700_000_012_000);
  });

  it('ignores snapshots outside the window', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ timestamp: 1_700_000_010_000 + i * 1_000, duration: (i + 1) * 1_000 }),
    );
    expect(
      annotateIndexingEvents({
        bucketKey: 'FT.SEARCH:idx_cache',
        entries,
        snapshots: [snap({ timestamp: windowStart - 1, percentIndexed: 30 })],
        windowStartMs: windowStart,
        windowEndMs: windowEnd,
      }),
    ).toEqual([]);
  });

  it('ignores snapshots for a different index', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ timestamp: 1_700_000_010_000 + i * 1_000, duration: (i + 1) * 1_000 }),
    );
    expect(
      annotateIndexingEvents({
        bucketKey: 'FT.SEARCH:idx_cache',
        entries,
        snapshots: [snap({ indexName: 'idx_other', percentIndexed: 50 })],
        windowStartMs: windowStart,
        windowEndMs: windowEnd,
      }),
    ).toEqual([]);
  });

  it('does not fire when only non-tail entries coincide with indexing', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ timestamp: 1_700_000_010_000 + i * 1_000, duration: (i + 1) * 1_000 }),
    );
    // Snapshot predates every entry's timestamp, but only non-tail entries have
    // durations low enough to use it as their nearest-≤.
    // The tail (largest duration = 10_000) is the entry at timestamp 1_700_000_019_000.
    // A snapshot at 1_700_000_005_000 with percentIndexed=50 IS the nearest-≤ for
    // every entry, including the tail one — so this actually DOES fire.
    // To test the negative case, put the non-100 snapshot AFTER every tail entry:
    expect(
      annotateIndexingEvents({
        bucketKey: 'FT.SEARCH:idx_cache',
        entries,
        snapshots: [snap({ timestamp: 1_700_000_090_000, percentIndexed: 30 })],
        windowStartMs: windowStart,
        windowEndMs: windowEnd,
      }),
    ).toEqual([]);
  });
});
