import { describe, it, expect } from 'vitest';
import { formatExpiresIn, formatTimeAgo, formatTtlSeconds } from './formatters';

describe('formatTtlSeconds', () => {
  it('formats sub-minute as seconds', () => {
    expect(formatTtlSeconds(0)).toBe('0s');
    expect(formatTtlSeconds(45)).toBe('45s');
  });

  it('formats minutes', () => {
    expect(formatTtlSeconds(60)).toBe('1m');
    expect(formatTtlSeconds(300)).toBe('5m');
    expect(formatTtlSeconds(90)).toBe('1.5m');
  });

  it('formats hours', () => {
    expect(formatTtlSeconds(3600)).toBe('1h');
    expect(formatTtlSeconds(7200)).toBe('2h');
  });

  it('formats days', () => {
    expect(formatTtlSeconds(86400)).toBe('1d');
  });

  it('falls back for negatives', () => {
    expect(formatTtlSeconds(-5)).toBe('-5s');
  });
});

describe('formatTimeAgo', () => {
  it('formats seconds, minutes, hours, days', () => {
    const now = 1_000_000_000_000;
    expect(formatTimeAgo(now - 30_000, now)).toBe('30s ago');
    expect(formatTimeAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatTimeAgo(now - 3 * 3600_000, now)).toBe('3h ago');
    expect(formatTimeAgo(now - 2 * 86400_000, now)).toBe('2d ago');
  });
});

describe('formatExpiresIn', () => {
  it('reports Expired when in the past', () => {
    const now = 1_000_000_000_000;
    expect(formatExpiresIn(now - 1000, now)).toBe('Expired');
  });

  it('formats hours and days remaining', () => {
    const now = 1_000_000_000_000;
    expect(formatExpiresIn(now + 18 * 3600_000, now)).toBe('Expires in 18h');
    expect(formatExpiresIn(now + 2 * 86400_000, now)).toBe('Expires in 2d');
  });
});
