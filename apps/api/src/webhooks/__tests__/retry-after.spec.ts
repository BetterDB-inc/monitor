import { RATE_LIMIT_MAX_DELAY_MS, parseRetryAfterMs } from '../retry-after';

describe('parseRetryAfterMs', () => {
  const now = 1_700_000_000_000;

  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('30', now)).toBe(30_000);
  });

  it('reads an HTTP-date', () => {
    const ms = parseRetryAfterMs(new Date(now + 30_000).toUTCString(), now) as number;
    expect(Math.abs(ms - 30_000)).toBeLessThanOrEqual(1000);
  });

  it('returns undefined for absent or invalid values', () => {
    expect(parseRetryAfterMs('abc', now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('caps long waits', () => {
    expect(parseRetryAfterMs('99999', now)).toBe(RATE_LIMIT_MAX_DELAY_MS);
  });

  it('returns 0 for a date in the past', () => {
    expect(parseRetryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
  });
});
