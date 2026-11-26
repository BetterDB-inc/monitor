import type { StoredLatencyHistogram } from '@app/common/interfaces/storage-port.interface';
import {
  MIN_INTERVAL_CALLS,
  callsPerMinute,
  diffSnapshots,
  intervalP99,
  intervalPoints,
  versionAt,
  versionTimeline,
} from '../interval-percentiles';

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

const snap = (timestamp: number, data: StoredLatencyHistogram['data']): StoredLatencyHistogram => ({
  id: `${timestamp}`,
  timestamp,
  data,
});

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
      intervalP99({ calls: 0, histogram: {} }, { calls, histogram: { '1048576': calls } }),
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
      histogram: {
        '256': baselineCalls,
        '512': baselineCalls,
        '1024': baselineCalls,
        '2048': baselineCalls,
      },
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

describe('intervalP99 gapped buckets and late resets', () => {
  it('interpolates inside the bucket when lower buckets are missing (new regression above the historical max)', () => {
    // 98% at <=4us, then a 2% slow tail with nothing emitted in between.
    const r = intervalP99(
      { calls: 0, histogram: {} },
      { calls: 10_000, histogram: { '4': 9800, '1024': 10_000 } },
    )!;
    expect(r.p99Us).toBeGreaterThan(512);
    expect(r.p99Us).toBeLessThanOrEqual(1024);
  });

  it('stays inside the bucket across a wide gap', () => {
    const r = intervalP99(
      { calls: 0, histogram: {} },
      { calls: 10_000, histogram: { '128': 9899, '8192': 10_000 } },
    )!;
    expect(r.p99Us).toBeGreaterThan(4096);
    expect(r.p99Us).toBeLessThanOrEqual(8192);
  });

  it('returns null when a bucket above the target bucket went backwards', () => {
    expect(
      intervalP99(
        { calls: 1000, histogram: { '256': 1000 } },
        { calls: 1100, histogram: { '128': 100, '256': 100, '8192': 1100 } },
      ),
    ).toBeNull();
  });
});

describe('diffSnapshots volumes', () => {
  it('records volume for quiet intervals that produce no P99 point', () => {
    const a = snap(T0, { get: { calls: 100, histogram: { '256': 100 } } });
    const b = snap(T0 + MINUTE, { get: { calls: 105, histogram: { '256': 105 } } });
    const { points, volumes } = diffSnapshots(a, b);
    expect(points).toEqual([]);
    expect(volumes).toEqual([{ command: 'get', calls: 5, startedAt: T0, capturedAt: T0 + MINUTE }]);
  });

  it('skips volume on reset', () => {
    const a = snap(T0, { get: { calls: 1000, histogram: { '256': 1000 } } });
    const b = snap(T0 + MINUTE, { get: { calls: 10, histogram: { '256': 10 } } });
    expect(diffSnapshots(a, b).volumes).toEqual([]);
  });

  it('averages alternating 100 and 0 calls per minute to 50/min', () => {
    let calls = 0;
    const snaps = [snap(T0, { get: { calls: 0, histogram: {} } })];
    for (let i = 1; i <= 10; i++) {
      calls += i % 2 === 1 ? 100 : 0;
      snaps.push(snap(T0 + i * MINUTE, { get: { calls, histogram: { '256': calls } } }));
    }
    const volumes = snaps.slice(1).flatMap((s, i) => diffSnapshots(snaps[i], s).volumes);
    expect(callsPerMinute(volumes, T0, T0 + 10 * MINUTE).get('get')).toBeCloseTo(50, 6);
  });
});

describe('versionTimeline', () => {
  type Row = { capturedAt: number; serverVersion: string };

  const linearScan = (rows: Row[], t: number) => {
    let best: Row | undefined;
    let earliest: Row | undefined;
    for (const r of rows) {
      if (!earliest || r.capturedAt < earliest.capturedAt) earliest = r;
      if (r.capturedAt <= t && (!best || r.capturedAt >= best.capturedAt)) best = r;
    }
    return (best ?? earliest)?.serverVersion ?? '';
  };

  it('matches the linear scan on unsorted rows with ties', () => {
    const versions = ['8.1.0', '8.1.1', '9.0.0'];
    let seed = 42;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const rows = Array.from({ length: 500 }, () => ({
      capturedAt: Math.floor(rand() * 200),
      serverVersion: versions[Math.floor(rand() * 3)],
    }));
    const lookup = versionTimeline(rows);
    for (let t = -5; t <= 205; t++) expect(lookup(t)).toBe(linearScan(rows, t));
    expect(versionTimeline([])(10)).toBe('');
  });

  it('keeps the first input row as the fallback when the earliest timestamp is tied', () => {
    const rows = [
      { capturedAt: 100, serverVersion: '8.1.0' },
      { capturedAt: 100, serverVersion: '9.0.0' },
    ];
    const lookup = versionTimeline(rows);
    expect(lookup(50)).toBe('8.1.0');
    expect(lookup(100)).toBe('9.0.0');
  });

  it('stays fast for 40 commands x 1440 minutes', () => {
    const rows: Row[] = [];
    for (let m = 0; m < 1440; m++) {
      for (let c = 0; c < 40; c++) {
        rows.push({ capturedAt: m * MINUTE, serverVersion: m < 720 ? '8.1.0' : '9.0.0' });
      }
    }
    const start = Date.now();
    const lookup = versionTimeline(rows);
    for (let m = 0; m < 1440; m++) for (let c = 0; c < 40; c++) lookup(m * MINUTE + 1);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
