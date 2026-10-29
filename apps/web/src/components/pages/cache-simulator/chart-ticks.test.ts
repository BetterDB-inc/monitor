import { describe, it, expect } from 'vitest';
import { byteAxis, dayTicks } from './chart-ticks';

const KB = 1024;
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;
const PB = 1024 ** 5;

const labels = (max: number, maxmemory: number | null = null) => {
  const axis = byteAxis(max, maxmemory);
  return axis?.ticks.map(axis.format);
};

describe('byteAxis', () => {
  it('steps by round amounts in the largest unit', () => {
    expect(byteAxis(10.8 * GB, null)?.ticks).toEqual([0, 2.5, 5, 7.5, 10, 12.5].map((n) => n * GB));
    expect(labels(10.8 * GB)).toEqual(['0 GB', '2.5 GB', '5.0 GB', '7.5 GB', '10.0 GB', '12.5 GB']);
  });

  it('covers the maximum with the last tick', () => {
    const ticks = byteAxis(5.59 * GB, null)?.ticks ?? [];
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(5.59 * GB);
    expect(ticks).toEqual([0, 2, 4, 6].map((n) => n * GB));
  });

  it('uses smaller units for small values', () => {
    expect(labels(73 * MB)).toEqual(['0 MB', '20 MB', '40 MB', '60 MB', '80 MB']);
  });

  it.each([
    ['1 MiB', MB, 'MB'],
    ['1 GiB', GB, 'GB'],
    ['1 TiB', TB, 'TB'],
  ])('labels every tick of an exact %s in that unit', (_, max, unit) => {
    expect(labels(max)).toEqual(['0', '0.2', '0.4', '0.6', '0.8', '1.0'].map((n) => `${n} ${unit}`));
  });

  it('keeps sub-unit steps in the unit of the maximum', () => {
    expect(labels(1.1 * GB)).toEqual(['0 GB', '0.25 GB', '0.50 GB', '0.75 GB', '1.00 GB', '1.25 GB']);
    expect(labels(1020 * MB)).toEqual(['0 MB', '250 MB', '500 MB', '750 MB', '1000 MB', '1250 MB']);
  });

  it('labels petabyte values', () => {
    expect(labels(1.5 * PB)).toEqual(['0 PB', '0.5 PB', '1.0 PB', '1.5 PB']);
  });

  it('labels kilobyte values', () => {
    expect(labels(3 * KB)).toEqual(['0 KB', '1 KB', '2 KB', '3 KB']);
  });

  it('adds a tick above maxmemory when it lands on the top tick', () => {
    expect(labels(0.5 * GB, GB)).toEqual(['0 GB', '0.2 GB', '0.4 GB', '0.6 GB', '0.8 GB', '1.0 GB', '1.2 GB']);
  });

  it('adds a tick above maxmemory when it sits just under the top tick', () => {
    expect(labels(10 * GB, 12 * GB)).toEqual(['0 GB', '2.5 GB', '5.0 GB', '7.5 GB', '10.0 GB', '12.5 GB', '15.0 GB']);
  });

  it('leaves the ticks alone when maxmemory has room above it', () => {
    expect(labels(5.59 * GB, 5 * GB)).toEqual(['0 GB', '2 GB', '4 GB', '6 GB']);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('returns no axis for a max of %s', (max) => {
    expect(byteAxis(max, null)).toBeNull();
  });
});

describe('dayTicks', () => {
  it('spaces six months by month', () => {
    expect(dayTicks(180)).toEqual([0, 30, 60, 90, 120, 150, 180]);
  });

  it('ends the six-month horizon on its last day', () => {
    expect(dayTicks(182)).toEqual([0, 30, 60, 90, 120, 150, 180, 182]);
  });

  it('spaces a month by week and ends on its last day', () => {
    expect(dayTicks(30)).toEqual([0, 7, 14, 21, 28, 30]);
  });

  it('spaces 90 days by month', () => {
    expect(dayTicks(90)).toEqual([0, 30, 60, 90]);
  });

  it('spaces a year by quarter and ends on its last day', () => {
    expect(dayTicks(365)).toEqual([0, 90, 180, 270, 360, 365]);
  });
});
