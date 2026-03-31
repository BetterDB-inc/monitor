import { describe, it, expect } from 'vitest';
import { formatMetricValue, formatGrowthRate, formatTime } from '../formatters';

describe('formatMetricValue', () => {
  it('formats bytes as GB', () => {
    expect(formatMetricValue(2_147_483_648, 'bytes')).toBe('2.0 GB');
  });

  it('formats bytes as MB', () => {
    expect(formatMetricValue(52_428_800, 'bytes')).toBe('50.0 MB');
  });

  it('formats bytes as KB', () => {
    expect(formatMetricValue(2048, 'bytes')).toBe('2.0 KB');
  });

  it('formats small bytes as B', () => {
    expect(formatMetricValue(512, 'bytes')).toBe('512 B');
  });

  it('formats percent', () => {
    expect(formatMetricValue(75.5, 'percent')).toBe('75.5%');
  });

  it('formats ratio', () => {
    expect(formatMetricValue(1.35, 'ratio')).toBe('1.35x');
  });

  it('formats ops as K', () => {
    expect(formatMetricValue(12_345, 'ops')).toBe('12.3K ops/sec');
  });

  it('formats ops as M', () => {
    expect(formatMetricValue(1_500_000, 'ops')).toBe('1.5M ops/sec');
  });

  it('formats small ops as integer', () => {
    expect(formatMetricValue(42, 'ops')).toBe('42 ops/sec');
  });

  it('formats zero for each type', () => {
    expect(formatMetricValue(0, 'bytes')).toBe('0 B');
    expect(formatMetricValue(0, 'percent')).toBe('0.0%');
    expect(formatMetricValue(0, 'ratio')).toBe('0.00x');
    expect(formatMetricValue(0, 'ops')).toBe('0 ops/sec');
  });
});

describe('formatGrowthRate', () => {
  it('formats positive growth', () => {
    expect(formatGrowthRate(5000, 'ops')).toBe('+5.0K/hr');
  });

  it('formats negative growth', () => {
    expect(formatGrowthRate(-1048576, 'bytes')).toBe('-1.0 MB/hr');
  });

  it('formats zero growth', () => {
    expect(formatGrowthRate(0, 'ops')).toBe('+0/hr');
  });
});

describe('formatTime', () => {
  it('returns a time string with hours and minutes', () => {
    const ts = new Date(2026, 2, 30, 14, 35).getTime();
    const result = formatTime(ts);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });
});
