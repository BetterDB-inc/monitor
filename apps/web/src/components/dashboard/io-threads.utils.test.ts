import { describe, it, expect } from 'vitest';
import { shouldShowIoChart, deriveStoredIoDeltas } from './io-threads.utils';
import type { StoredMemorySnapshot } from '../../types/metrics';

const stub = (overrides: Partial<StoredMemorySnapshot> = {}): StoredMemorySnapshot => ({
  id: '1',
  timestamp: 1_700_000_000_000,
  usedMemory: 0,
  usedMemoryRss: 0,
  usedMemoryPeak: 0,
  memFragmentationRatio: 0,
  maxmemory: 0,
  allocatorFragRatio: 0,
  opsPerSec: 0,
  cpuSys: 0,
  cpuUser: 0,
  ioThreadedReads: 0,
  ioThreadedWrites: 0,
  ...overrides,
});

describe('shouldShowIoChart', () => {
  it('should return false when single-threaded, no activity, no data', () => {
    expect(shouldShowIoChart(false, false, [])).toBe(false);
  });

  it('should return false when data has only zero values', () => {
    const data = [
      { time: '1', reads: 0, writes: 0 },
      { time: '2', reads: 0, writes: 0 },
    ];
    expect(shouldShowIoChart(false, false, data)).toBe(false);
  });

  it('should return true when isMultiThreaded is true', () => {
    expect(shouldShowIoChart(true, false, [])).toBe(true);
  });

  it('should return true when hasEverSeenActivity is true', () => {
    expect(shouldShowIoChart(false, true, [])).toBe(true);
  });

  it('should return true when data contains non-zero reads', () => {
    const data = [{ time: '1', reads: 100, writes: 0 }];
    expect(shouldShowIoChart(false, false, data)).toBe(true);
  });

  it('should return true when data contains non-zero writes', () => {
    const data = [{ time: '1', reads: 0, writes: 50 }];
    expect(shouldShowIoChart(false, false, data)).toBe(true);
  });
});

describe('deriveStoredIoDeltas', () => {
  const fmt = (ts: number) => `t${ts}`;

  it('should return empty array for empty input', () => {
    expect(deriveStoredIoDeltas([], fmt)).toEqual([]);
  });

  it('should return empty array for a single snapshot', () => {
    expect(deriveStoredIoDeltas([stub()], fmt)).toEqual([]);
  });

  it('should compute per-second rates between consecutive snapshots', () => {
    // 5 seconds apart, 50 count delta → 10/s
    const snapshots = [
      stub({ timestamp: 0, ioThreadedReads: 100, ioThreadedWrites: 200 }),
      stub({ timestamp: 5000, ioThreadedReads: 150, ioThreadedWrites: 250 }),
      stub({ timestamp: 10000, ioThreadedReads: 300, ioThreadedWrites: 400 }),
    ];

    const result = deriveStoredIoDeltas(snapshots, fmt);

    expect(result).toEqual([
      { time: 't5000', reads: 10, writes: 10 },
      { time: 't10000', reads: 30, writes: 30 },
    ]);
  });

  it('should clamp negative deltas to zero (counter reset)', () => {
    const snapshots = [
      stub({ timestamp: 0, ioThreadedReads: 500, ioThreadedWrites: 300 }),
      stub({ timestamp: 5000, ioThreadedReads: 100, ioThreadedWrites: 50 }),
    ];

    const result = deriveStoredIoDeltas(snapshots, fmt);

    expect(result).toEqual([
      { time: 't5000', reads: 0, writes: 0 },
    ]);
  });

  it('should handle missing ioThreadedReads/Writes (defaults to 0)', () => {
    const snapshots = [
      stub({ timestamp: 0 }),
      stub({ timestamp: 10000, ioThreadedReads: 100, ioThreadedWrites: 200 }),
    ];
    delete (snapshots[0] as any).ioThreadedReads;
    delete (snapshots[0] as any).ioThreadedWrites;

    const result = deriveStoredIoDeltas(snapshots, fmt);

    // 100 / 10s = 10/s, 200 / 10s = 20/s
    expect(result).toEqual([
      { time: 't10000', reads: 10, writes: 20 },
    ]);
  });

  it('should handle zero time delta gracefully', () => {
    const snapshots = [
      stub({ timestamp: 5000, ioThreadedReads: 100, ioThreadedWrites: 200 }),
      stub({ timestamp: 5000, ioThreadedReads: 200, ioThreadedWrites: 300 }),
    ];

    const result = deriveStoredIoDeltas(snapshots, fmt);

    expect(result).toEqual([
      { time: 't5000', reads: 0, writes: 0 },
    ]);
  });

  it('should produce correct length (input length - 1)', () => {
    // 5 snapshots, 5s apart each, uniform deltas of 10 reads and 5 writes per interval
    const snapshots = Array.from({ length: 5 }, (_, i) =>
      stub({ timestamp: i * 5000, ioThreadedReads: i * 10, ioThreadedWrites: i * 5 }),
    );

    const result = deriveStoredIoDeltas(snapshots, fmt);

    expect(result).toHaveLength(4);
    // 10 count / 5 sec = 2/s reads, 5 count / 5 sec = 1/s writes
    result.forEach(d => {
      expect(d.reads).toBe(2);
      expect(d.writes).toBe(1);
    });
  });
});
