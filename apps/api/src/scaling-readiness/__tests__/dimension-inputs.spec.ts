import type { MetricForecast } from '@betterdb/shared';
import type { StoredMemorySnapshot } from '../../common/interfaces/storage-port.interface';
import {
  connectionsInput,
  cpuInput,
  forecastInput,
  formatBytes,
  growthInput,
  memoryInput,
  weeklyGrowthPercent,
} from '../dimension-inputs';
import { DAY_MS } from '../scoring';

const snap = (o: Partial<StoredMemorySnapshot> = {}): StoredMemorySnapshot => ({
  id: 'x', timestamp: 0, usedMemory: 0, usedMemoryRss: null, usedMemoryPeak: null,
  memFragmentationRatio: null, maxmemory: 0, allocatorFragRatio: null, opsPerSec: 0,
  cpuSys: 0, cpuUser: 0, ioThreadedReads: null, ioThreadedWrites: null,
  connectedClients: null, maxclients: null, totalKeys: null, ...o,
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [4 * 1024 ** 3, '4 GB'],
    [1.5 * 1024 ** 2, '1.5 MB'],
  ])('%p -> %p', (bytes, text) => expect(formatBytes(bytes)).toBe(text));
});

describe('memoryInput', () => {
  it('excludes when maxmemory is not set', () =>
    expect(memoryInput(snap({ usedMemory: 10 }))).toEqual({ excludedReason: 'maxmemory not set' }));
  it('scores utilization with a percent-of-limit detail', () =>
    expect(memoryInput(snap({ usedMemory: 0.82 * 4 * 1024 ** 3, maxmemory: 4 * 1024 ** 3 }))).toEqual({
      score: expect.closeTo(28.89, 1),
      detail: '82% of 4 GB',
    }));
});

describe('connectionsInput', () => {
  it('excludes external connections without maxclients', () =>
    expect(connectionsInput(snap({ connectedClients: 5 }), true)).toEqual({
      excludedReason: 'Not reported over OTLP',
    }));
  it('excludes direct connections without maxclients', () =>
    expect(connectionsInput(snap({ connectedClients: 5 }), false)).toEqual({
      excludedReason: 'maxclients unavailable',
    }));
  it('scores connected clients against maxclients', () =>
    expect(connectionsInput(snap({ connectedClients: 50, maxclients: 100 }), false)).toEqual({
      score: 100,
      detail: '50 of 100 clients',
    }));
});

describe('cpuInput', () => {
  it('excludes without samples', () =>
    expect(cpuInput([], 1, null)).toEqual({ excludedReason: 'No CPU samples yet' }));
  it('divides mean CPU by the effective thread count', () =>
    expect(cpuInput([snap({ cpuSys: 100, cpuUser: 40 }), snap({ cpuSys: 100, cpuUser: 40 })], 2, null)).toEqual({
      score: expect.closeTo(50, 6),
      detail: '140% CPU across 2 threads',
    }));
  it('appends the thread note', () =>
    expect((cpuInput([snap({ cpuSys: 10 })], 1, 'thread count could not be read') as any).detail).toBe(
      '10% CPU across 1 thread (thread count could not be read)',
    ));
});

describe('weeklyGrowthPercent', () => {
  it('returns null under 24h of data', () =>
    expect(weeklyGrowthPercent([{ timestamp: 0, value: 1 }, { timestamp: DAY_MS - 1, value: 2 }])).toBeNull());
  it('extrapolates the regression to a weekly change', () =>
    expect(
      weeklyGrowthPercent([
        { timestamp: 0, value: 100 },
        { timestamp: DAY_MS, value: 110 },
        { timestamp: 2 * DAY_MS, value: 120 },
      ]),
    ).toBeCloseTo(70));
  it('treats growth from zero as unbounded', () =>
    expect(weeklyGrowthPercent([{ timestamp: 0, value: 0 }, { timestamp: DAY_MS, value: 5 }])).toBe(Infinity));
});

describe('growthInput', () => {
  it('excludes under 24h', () =>
    expect(growthInput([], 'Keys')).toEqual({ excludedReason: 'Needs 24h of history' }));
  it('scores shrinking series as full headroom', () =>
    expect(growthInput([{ timestamp: 0, value: 10 }, { timestamp: DAY_MS, value: 5 }], 'Keys')).toEqual({
      score: 100,
      detail: 'Keys flat or shrinking week over week',
    }));
  it('describes growth', () =>
    expect(
      growthInput([{ timestamp: 0, value: 100 }, { timestamp: 7 * DAY_MS, value: 125 }], 'Ops/sec'),
    ).toEqual({ score: 50, detail: 'Ops/sec growing 25% per week' }));
});

describe('forecastInput', () => {
  const base = {
    mode: 'forecast', currentValue: 1, growthRate: 0, growthPercent: 0, trendDirection: 'rising',
    ceiling: 1000, timeToLimitMs: 15.5 * DAY_MS, timeToLimitHuman: '~15 days',
    enabled: true, insufficientData: false,
  } as unknown as MetricForecast;
  it('returns null without a usable ceiling forecast', () => {
    expect(forecastInput(null)).toBeNull();
    expect(forecastInput({ ...base, mode: 'trend', ceiling: null })).toBeNull();
    expect(forecastInput({ ...base, enabled: false })).toBeNull();
    expect(forecastInput({ ...base, insufficientData: true })).toBeNull();
  });
  it('maps time-to-limit', () =>
    expect(forecastInput(base)).toEqual({ score: 50, detail: '~15 days to the ops/sec ceiling' }));
  it('treats a non-rising forecast as full headroom', () =>
    expect(forecastInput({ ...base, timeToLimitMs: null })).toEqual({
      score: 100,
      detail: 'Not projected to reach the ops/sec ceiling',
    }));
  it('scores an exceeded ceiling as zero', () =>
    expect(forecastInput({ ...base, timeToLimitMs: 0 })).toEqual({
      score: 0,
      detail: 'Ops/sec ceiling already exceeded',
    }));
});
