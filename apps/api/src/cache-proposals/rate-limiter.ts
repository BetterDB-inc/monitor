export interface RateLimiterCheck {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export interface RateLimiterReservation extends RateLimiterCheck {
  releaseToken?: number;
}

interface BucketEntry {
  ts: number;
  token: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, BucketEntry[]>();
  private nextToken = 1;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimiterCheck {
    const ts = this.now();
    const cutoff = ts - this.windowMs;
    const events = this.prune(key, cutoff);

    if (events.length >= this.limit) {
      const oldest = events[0].ts;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - ts);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    return { allowed: true, retryAfterMs: 0, remaining: this.limit - events.length };
  }

  record(key: string): number {
    const ts = this.now();
    const cutoff = ts - this.windowMs;
    const events = this.prune(key, cutoff);
    const token = this.nextToken;
    this.nextToken += 1;
    events.push({ ts, token });
    this.buckets.set(key, events);
    return token;
  }

  reserve(key: string): RateLimiterReservation {
    const result = this.check(key);
    if (!result.allowed) {
      return result;
    }
    const releaseToken = this.record(key);
    return {
      ...result,
      remaining: Math.max(0, result.remaining - 1),
      releaseToken,
    };
  }

  release(key: string, token: number): void {
    const events = this.buckets.get(key);
    if (events === undefined || events.length === 0) {
      return;
    }
    const idx = events.findIndex((e) => e.token === token);
    if (idx < 0) {
      return;
    }
    events.splice(idx, 1);
    if (events.length === 0) {
      this.buckets.delete(key);
    }
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
      return;
    }
    this.buckets.delete(key);
  }

  private prune(key: string, cutoff: number): BucketEntry[] {
    const existing = this.buckets.get(key) ?? [];
    let firstFresh = 0;
    while (firstFresh < existing.length && existing[firstFresh].ts <= cutoff) {
      firstFresh += 1;
    }
    if (firstFresh === 0) {
      return existing;
    }
    const pruned = existing.slice(firstFresh);
    this.buckets.set(key, pruned);
    return pruned;
  }
}
