import { SlidingWindowRateLimiter } from '../rate-limiter';

describe('SlidingWindowRateLimiter', () => {
  it('allows up to limit, blocks the next, then allows after the oldest event ages out', () => {
    let now = 1_000_000;
    const limiter = new SlidingWindowRateLimiter(3, 1_000, () => now);

    expect(limiter.check('k').allowed).toBe(true);
    limiter.record('k');
    now += 100;

    expect(limiter.check('k').allowed).toBe(true);
    limiter.record('k');
    now += 100;

    expect(limiter.check('k').allowed).toBe(true);
    limiter.record('k');
    now += 100;

    const blocked = limiter.check('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(700);

    now += 800;
    expect(limiter.check('k').allowed).toBe(true);
  });

  it('isolates buckets across keys', () => {
    const now = 0;
    const limiter = new SlidingWindowRateLimiter(2, 1_000, () => now);
    limiter.record('a');
    limiter.record('a');
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(true);
  });

  it('reset(key) clears only that key', () => {
    const now = 0;
    const limiter = new SlidingWindowRateLimiter(1, 1_000, () => now);
    limiter.record('a');
    limiter.record('b');
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(false);
    limiter.reset('a');
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(false);
  });
});
