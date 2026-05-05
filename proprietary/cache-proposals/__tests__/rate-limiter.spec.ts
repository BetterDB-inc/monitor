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

  it('reserve() returns post-record remaining when allowed', () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter(3, 1_000, () => now);

    expect(limiter.reserve('k').remaining).toBe(2);
    now += 1;
    expect(limiter.reserve('k').remaining).toBe(1);
    now += 1;
    expect(limiter.reserve('k').remaining).toBe(0);
    now += 1;
    const blocked = limiter.reserve('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.releaseToken).toBeUndefined();
  });

  it('release(key, token) frees the specific reservation, not the newest', () => {
    let now = 1_000;
    const limiter = new SlidingWindowRateLimiter(2, 1_000, () => now);

    const a = limiter.reserve('k');
    now += 10;
    const b = limiter.reserve('k');
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);

    now += 10;
    const blocked = limiter.reserve('k');
    expect(blocked.allowed).toBe(false);

    limiter.release('k', a.releaseToken!);

    const refreshed = limiter.reserve('k');
    expect(refreshed.allowed).toBe(true);

    const blockedAgain = limiter.reserve('k');
    expect(blockedAgain.allowed).toBe(false);

    limiter.release('k', b.releaseToken!);
    expect(limiter.reserve('k').allowed).toBe(true);
  });

  it('release(key, unknown-token) is a no-op', () => {
    const now = 1_000;
    const limiter = new SlidingWindowRateLimiter(1, 1_000, () => now);
    const r = limiter.reserve('k');
    expect(limiter.reserve('k').allowed).toBe(false);
    limiter.release('k', 999_999);
    expect(limiter.reserve('k').allowed).toBe(false);
    limiter.release('k', r.releaseToken!);
    expect(limiter.reserve('k').allowed).toBe(true);
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
