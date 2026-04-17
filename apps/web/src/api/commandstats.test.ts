import { describe, expect, it } from 'vitest';
import { opsPerSec, avgLatencyUs, toChartSeries, type CommandStatsSample } from './commandstats';

function sample(overrides: Partial<CommandStatsSample> = {}): CommandStatsSample {
  return {
    id: '1',
    connectionId: 'conn',
    command: 'ft.search',
    callsDelta: 100,
    usecDelta: 5_000,
    intervalMs: 10_000,
    capturedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('opsPerSec', () => {
  it('divides callsDelta by interval in seconds', () => {
    expect(opsPerSec(sample({ callsDelta: 30, intervalMs: 15_000 }))).toBeCloseTo(2, 6);
  });

  it('returns 0 when intervalMs is 0', () => {
    expect(opsPerSec(sample({ callsDelta: 30, intervalMs: 0 }))).toBe(0);
  });
});

describe('avgLatencyUs', () => {
  it('divides usecDelta by callsDelta', () => {
    expect(avgLatencyUs(sample({ usecDelta: 5_000, callsDelta: 100 }))).toBe(50);
  });

  it('returns 0 when callsDelta is 0', () => {
    expect(avgLatencyUs(sample({ usecDelta: 5_000, callsDelta: 0 }))).toBe(0);
  });
});

describe('toChartSeries', () => {
  it('maps samples to sorted chart points', () => {
    const series = toChartSeries([
      sample({ capturedAt: 3000, callsDelta: 20, intervalMs: 10_000, usecDelta: 2_000 }),
      sample({ capturedAt: 1000, callsDelta: 10, intervalMs: 10_000, usecDelta: 1_000 }),
      sample({ capturedAt: 2000, callsDelta: 15, intervalMs: 10_000, usecDelta: 1_500 }),
    ]);

    expect(series.map((p) => p.capturedAt)).toEqual([1000, 2000, 3000]);
    expect(series[0].opsPerSec).toBeCloseTo(1, 6);
    expect(series[1].opsPerSec).toBeCloseTo(1.5, 6);
    expect(series[2].opsPerSec).toBeCloseTo(2, 6);
    expect(series[0].avgLatencyUs).toBe(100);
  });

  it('returns empty array for empty input', () => {
    expect(toChartSeries([])).toEqual([]);
  });
});
