import { DEFAULT_OVERHEAD_PER_KEY_BYTES, fixedOverhead, inPlaceGrowth, keysAt, project, type ProjectionInputs } from '@betterdb/shared';

const base: ProjectionInputs = {
  currentKeys: 1000,
  keysPerDay: 100,
  inPlaceBytesPerDay: 0,
  ttlDays: null,
  avgKeyBytes: 100,
  ci95Bytes: 0,
  overheadPerKeyBytes: 0,
  fixedOverheadBytes: 0,
  maxmemory: null,
  horizonDays: 30,
};

describe('projection', () => {
  it('uses 88 bytes as the default per-key overhead', () => {
    expect(DEFAULT_OVERHEAD_PER_KEY_BYTES).toBe(88);
  });

  it('projects linear growth', () => {
    const result = project(base);
    expect(result.points).toHaveLength(31);
    expect(result.points[10]).toMatchObject({ day: 10, keys: 2000, bytes: 200_000 });
  });

  it('never projects negative keys', () => {
    expect(keysAt(10, { ...base, keysPerDay: -500 })).toBe(0);
    const result = project({ ...base, keysPerDay: -500, maxmemory: 1_000_000 });
    expect(result.points.every((point) => point.keys >= 0 && point.bytes >= 0)).toBe(true);
    expect(result.daysToMaxmemory).toBeNull();
  });

  it('converges to the TTL steady state', () => {
    const inputs = { ...base, currentKeys: 0, keysPerDay: 100, ttlDays: 7 };
    expect(keysAt(7, inputs)).toBeCloseTo(700 * (1 - Math.exp(-1)), 6);
    expect(keysAt(70, inputs)).toBeCloseTo(700, 0);
  });

  it('decays toward the steady state from above', () => {
    expect(keysAt(1000, { ...base, currentKeys: 10_000, keysPerDay: 100, ttlDays: 7 })).toBeCloseTo(700, 0);
  });

  it('adds per-key and fixed overhead', () => {
    const result = project({ ...base, overheadPerKeyBytes: 50, fixedOverheadBytes: 1000 });
    expect(result.points[0].bytes).toBe(1000 * 150 + 1000);
  });

  it('finds the first day at maxmemory and at 80%', () => {
    const result = project({ ...base, maxmemory: 150_000 });
    expect(result.daysToMaxmemory).toBe(5);
    expect(result.daysTo80Percent).toBe(2);
  });

  it('returns day 0 when already over the limit', () => {
    expect(project({ ...base, maxmemory: 50_000 }).daysToMaxmemory).toBe(0);
  });

  it('handles null and zero maxmemory', () => {
    expect(project(base).daysToMaxmemory).toBeNull();
    expect(project({ ...base, maxmemory: 0 }).daysToMaxmemory).toBeNull();
    expect(project({ ...base, maxmemory: 0 }).daysTo80Percent).toBeNull();
  });

  it('anchors the band to the sampled interval and scales it with the key count', () => {
    const result = project({ ...base, ci95Bytes: 5000 });
    expect(result.points[0].high - result.points[0].bytes).toBeCloseTo(5000, 6);
    expect(result.points[0].bytes - result.points[0].low).toBeCloseTo(5000, 6);
    expect(result.points[10].high - result.points[10].bytes).toBeCloseTo(10_000, 6);
  });

  it('has no band without an interval', () => {
    const point = project(base).points[0];
    expect(point.low).toBe(point.bytes);
    expect(point.high).toBe(point.bytes);
  });

  it('adds in-place byte growth on top of key growth', () => {
    const result = project({ ...base, keysPerDay: 0, inPlaceBytesPerDay: 500, maxmemory: 102_000 });
    expect(result.points[10].bytes).toBe(100_000 + 5000);
    expect(result.daysToMaxmemory).toBe(4);
  });

  it('derives in-place growth from the byte trend new keys do not explain', () => {
    expect(inPlaceGrowth({ keysPerDay: 0, bytesPerDay: 500 }, 100)).toBe(500);
    expect(inPlaceGrowth({ keysPerDay: 100, bytesPerDay: 8000 }, 100)).toBe(0);
    expect(inPlaceGrowth({ keysPerDay: 10, bytesPerDay: 3000 }, 100)).toBe(2000);
    expect(inPlaceGrowth({ keysPerDay: -500, bytesPerDay: 0 }, 100)).toBe(0);
  });

  it('stays finite with zero keys', () => {
    const result = project({ ...base, currentKeys: 0, keysPerDay: 0, maxmemory: 100 });
    expect(result.points.every((point) => Number.isFinite(point.bytes))).toBe(true);
    expect(result.daysToMaxmemory).toBeNull();
  });

  it('floors fixed overhead at zero', () => {
    expect(fixedOverhead(1000, 10, 100, 88)).toBe(0);
    expect(fixedOverhead(10_000, 10, 100, 88)).toBe(10_000 - 10 * 188);
  });
});
