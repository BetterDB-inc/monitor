import { describe, it, expect } from 'vitest';
import { formatValue } from './AnomalyDashboard';

describe('formatValue', () => {
  it('keeps a replication gap below 1 KiB in bytes', () => {
    expect(formatValue(500, 'replication_divergence')).toBe('500.00 B');
    expect(formatValue(100, 'replication_divergence')).toBe('100.00 B');
  });

  it('keeps a fractional replication gap in bytes', () => {
    expect(formatValue(0.5, 'replication_divergence')).toBe('0.50 B');
  });

  it('writes larger replication gaps like the replication panel', () => {
    expect(formatValue(8 * 1024 ** 2, 'replication_divergence')).toBe('8.00 MB');
  });
});
