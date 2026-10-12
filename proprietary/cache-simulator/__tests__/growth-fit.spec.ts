import { Feature, Tier, TIER_FEATURES } from '@betterdb/shared';
import { fitGrowth, leastSquaresSlope, readGrowth, sumGrowth } from '../growth-fit';

const DAY = 86_400_000;
const series = (days: number, perDay: number, keysPerPoint: (day: number) => number | null = (day) => 1000 + 50 * day) =>
  Array.from({ length: perDay * days + 1 }, (_, index) => {
    const day = index / perDay;
    return { timestamp: day * DAY, usedMemory: 1_000_000 + 4000 * day, totalKeys: keysPerPoint(day) };
  });

describe('growth fit', () => {
  it('is a Pro feature', () => {
    expect(TIER_FEATURES[Tier.pro]).toContain(Feature.CACHE_SIZE_SIMULATOR);
    expect(TIER_FEATURES[Tier.community]).not.toContain(Feature.CACHE_SIZE_SIMULATOR);
  });

  it('computes a least-squares slope', () => {
    expect(leastSquaresSlope([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 5 }])).toBeCloseTo(2, 9);
    expect(leastSquaresSlope([{ x: 1, y: 1 }, { x: 1, y: 2 }])).toBe(0);
  });

  it('fits keys and bytes per day', () => {
    const result = fitGrowth(series(10, 24))!;
    expect(result.keysPerDay).toBeCloseTo(50, 6);
    expect(result.bytesPerDay).toBeCloseTo(4000, 6);
    expect(result.days).toBeCloseTo(10, 6);
  });

  it('returns null with less than a day of history', () => {
    expect(fitGrowth(series(0.5, 48))).toBeNull();
  });

  it('returns null with too few key counts', () => {
    expect(fitGrowth(series(10, 24, (day) => (day < 0.3 ? 1000 : null)))).toBeNull();
  });

  it('sums per-primary fits and takes the shortest history', () => {
    expect(sumGrowth([{ keysPerDay: 50, bytesPerDay: 4000, days: 10 }, { keysPerDay: 30, bytesPerDay: 1000, days: 6 }])).toEqual({ keysPerDay: 80, bytesPerDay: 5000, days: 6 });
    expect(sumGrowth([{ keysPerDay: 5, bytesPerDay: 7, days: 3 }])).toEqual({ keysPerDay: 5, bytesPerDay: 7, days: 3 });
  });

  it('has no summed growth when any primary lacks history', () => {
    expect(sumGrowth([{ keysPerDay: 50, bytesPerDay: 4000, days: 10 }, null])).toBeNull();
    expect(sumGrowth([])).toBeNull();
  });

  it('reads the last 30 days and survives storage errors', async () => {
    const storage = { getMemorySnapshots: jest.fn().mockResolvedValue(series(10, 24)) };
    await readGrowth(storage as any, 'c1', 40 * DAY);
    expect(storage.getMemorySnapshots).toHaveBeenCalledWith({ connectionId: 'c1', startTime: 10 * DAY, endTime: 40 * DAY, limit: 50_000 });
    const failing = { getMemorySnapshots: jest.fn().mockRejectedValue(new Error('down')) };
    await expect(readGrowth(failing as any, 'c1', 40 * DAY)).resolves.toBeNull();
  });
});
