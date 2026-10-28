import { describe, it, expect } from 'vitest';
import { byteTicks, dayAxis, dayTicks } from './chart-ticks';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('byteTicks', () => {
  it('steps by round amounts in the largest unit', () => {
    expect(byteTicks(10.8 * GB)).toEqual([0, 2.5, 5, 7.5, 10, 12.5].map((n) => n * GB));
  });

  it('covers the maximum with the last tick', () => {
    const ticks = byteTicks(5.59 * GB);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(5.59 * GB);
    expect(ticks).toEqual([0, 2, 4, 6].map((n) => n * GB));
  });

  it('uses smaller units for small values', () => {
    expect(byteTicks(73 * MB)).toEqual([0, 20, 40, 60, 80].map((n) => n * MB));
  });

  it('returns a single zero tick for an empty range', () => {
    expect(byteTicks(0)).toEqual([0]);
  });
});

describe('dayTicks', () => {
  it('spaces six months evenly by month', () => {
    expect(dayTicks(180)).toEqual([0, 30, 60, 90, 120, 150, 180]);
  });

  it('spaces the six-month horizon by month', () => {
    expect(dayTicks(182)).toEqual([0, 30, 60, 90, 120, 150, 180]);
  });

  it('spaces a month by week', () => {
    expect(dayTicks(30)).toEqual([0, 7, 14, 21, 28]);
  });

  it('spaces a year by quarter', () => {
    expect(dayTicks(365)).toEqual([0, 90, 180, 270, 360]);
  });
});

describe('dayAxis', () => {
  it('ends the domain at the horizon when the last tick falls short of it', () => {
    expect(dayAxis(30)).toEqual({ domain: [0, 30], ticks: dayTicks(30) });
    expect(dayAxis(182)).toEqual({ domain: [0, 182], ticks: dayTicks(182) });
  });
});
