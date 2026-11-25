import type { StoredLatencyHistogram } from '@app/common/interfaces/storage-port.interface';
import {
  MIN_INTERVAL_CALLS,
  callsPerMinute,
  intervalP99,
  intervalPoints,
  versionAt,
} from '../interval-percentiles';

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

const snap = (
  timestamp: number,
  data: StoredLatencyHistogram['data'],
): StoredLatencyHistogram => ({ id: `${timestamp}`, timestamp, data });

describe('intervalP99', () => {
  it('puts the P99 inside the bucket when every call lands in one bucket', () => {
    const result = intervalP99(
      { calls: 100, histogram: { '256': 100, '512': 100 } },
      { calls: 300, histogram: { '256': 100, '512': 300 } },
    );
    expect(result?.calls).toBe(200);
    expect(result!.p99Us).toBeGreaterThan(256);
    expect(result!.p99Us).toBeLessThanOrEqual(512);
  });

  it('lands exactly on the bucket bound when 99% falls on a boundary', () => {
    // 1000 calls: 990 at <=128us, 10 at <=1024us. Target 990 is reached at the 128 bucket.
    const result = intervalP99(
      { calls: 0, histogram: {} },
      { calls: 1000, histogram: { '128': 990, '1024': 1000 } },
    );
    expect(result!.p99Us).toBeCloseTo(128, 6);
  });

  it('interpolates geometrically between the bucket below and the bucket above', () => {
    // 1000 calls: 500 in (64,128], 500 in (128,256]. Target 990 is 98% through the (128,256] bucket.
    const result = intervalP99(
      { calls: 0, histogram: {} },
      { calls: 1000, histogram: { '128': 500, '256': 1000 } },
    );
    const expected = 128 * Math.pow(2, (990 - 500) / 500);
    expect(result!.p99Us).toBeCloseTo(expected, 6);
  });

  it('carries a missing middle bucket forward', () => {
    // 'before' has no 512 bucket; its cumulative count there is the 256 bucket's 50.
    const result = intervalP99(
      { calls: 50, histogram: { '256': 50, '1024': 50 } },
      { calls: 250, histogram: { '256': 60, '512': 60, '1024': 250 } },
    );
    // Interval: <=256: 10, <=512: 10, <=1024: 200. All of the P99 sits in (512, 1024].
    expect(result!.calls).toBe(200);
    expect(result!.p99Us).toBeGreaterThan(512);
    expect(result!.p99Us).toBeLessThanOrEqual(1024);
  });

  it('returns null when the call counter went backwards (reset)', () => {
    expect(
      intervalP99(
        { calls: 5000, histogram: { '256': 5000 } },
        { calls: 100, histogram: { '256': 100 } },
      ),
    ).toBeNull();
  });

  it('returns null when one bucket went backwards even though calls grew', () => {
    expect(
      intervalP99(
        { calls: 100, histogram: { '256': 100, '512': 100 } },
        { calls: 400, histogram: { '256': 40, '512': 400 } },
      ),
    ).toBeNull();
  });

  it('skips intervals with fewer than the minimum number of calls', () => {
    const calls = MIN_INTERVAL_CALLS - 1;
    expect(
      intervalP99(
        { calls: 0, histogram: {} },
        { calls, histogram: { '1048576': calls } },
      ),
    ).toBeNull();
  });

  it('returns null without a previous snapshot or when buckets never reach 99%', () => {
    expect(intervalP99(undefined, { calls: 100, histogram: { '256': 100 } })).toBeNull();
    expect(
      intervalP99({ calls: 0, histogram: {} }, { calls: 100, histogram: { '256': 50 } }),
    ).toBeNull();
  });

  it('sees a regression that the lifetime P99 hides', () => {
    // 30 days of 200us traffic (1000 calls/min), then one minute at 2,000us.
    const baselineCalls = 43_200 * 1000;
    const a = {
      calls: baselineCalls,
      histogram: { '256': baselineCalls, '512': baselineCalls, '1024': baselineCalls, '2048': baselineCalls },
    };
    const b = {
      calls: baselineCalls + 1000,
      histogram: {
        '256': baselineCalls,
        '512': baselineCalls,
        '1024': baselineCalls,
        '2048': baselineCalls + 1000,
      },
    };
    const lifetime = intervalP99({ calls: 0, histogram: {} }, b)!;
    const interval = intervalP99(a, b)!;
    expect(lifetime.p99Us).toBeLessThanOrEqual(256); // cumulative P99 barely moves
    expect(interval.p99Us).toBeGreaterThan(1024); // interval P99 sees the 2,000us minute
    expect(interval.p99Us).toBeLessThanOrEqual(2048);
  });
});

describe('intervalPoints', () => {
  it('lower-cases command names and keeps the cmd|sub form', () => {
    const before = snap(T0, { 'CLIENT|LIST': { calls: 0, histogram: {} } });
    const after = snap(T0 + MINUTE, {
      'CLIENT|LIST': { calls: 100, histogram: { '256': 100 } },
    });
    const points = intervalPoints(before, after);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      command: 'client|list',
      calls: 100,
      startedAt: T0,
      capturedAt: T0 + MINUTE,
    });
  });

  it('drops commands that reset, skips new commands, and keeps the rest', () => {
    const before = snap(T0, {
      get: { calls: 1000, histogram: { '256': 1000 } },
      set: { calls: 5000, histogram: { '256': 5000 } },
    });
    const after = snap(T0 + MINUTE, {
      get: { calls: 1500, histogram: { '256': 1500 } },
      set: { calls: 10, histogram: { '256': 10 } }, // reset
      hget: { calls: 500, histogram: { '256': 500 } }, // no prior snapshot
    });
    expect(intervalPoints(before, after).map((p) => p.command)).toEqual(['get']);
  });

  it('returns nothing when snapshots are not in time order', () => {
    const a = snap(T0, { get: { calls: 0, histogram: {} } });
    const b = snap(T0, { get: { calls: 100, histogram: { '256': 100 } } });
    expect(intervalPoints(a, b)).toEqual([]);
  });
});

describe('callsPerMinute', () => {
  it('averages call volume over the points inside the window', () => {
    const point = (capturedAt: number, calls: number) => ({
      command: 'get',
      p99Us: 100,
      calls,
      startedAt: capturedAt - MINUTE,
      capturedAt,
    });
    const points = [
      point(T0 + MINUTE, 9999), // outside the window
      point(T0 + 2 * MINUTE, 100),
      point(T0 + 3 * MINUTE, 300),
    ];
    const result = callsPerMinute(points, T0 + 2 * MINUTE, T0 + 3 * MINUTE);
    expect(result.get('get')).toBeCloseTo(200, 6);
  });
});

describe('versionAt', () => {
  const rows = [
    { capturedAt: 300, serverVersion: '9.0.0' },
    { capturedAt: 100, serverVersion: '8.1.0' },
    { capturedAt: 200, serverVersion: '8.1.1' },
  ];

  it('picks the latest version at or before the timestamp', () => {
    expect(versionAt(rows, 250)).toBe('8.1.1');
    expect(versionAt(rows, 300)).toBe('9.0.0');
    expect(versionAt(rows, 10_000)).toBe('9.0.0');
  });

  it('falls back to the earliest row, then to an empty string', () => {
    expect(versionAt(rows, 50)).toBe('8.1.0');
    expect(versionAt([], 50)).toBe('');
  });
});
