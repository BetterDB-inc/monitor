export interface RateLimiterCheck {
  allowed: boolean;
  retryAfterMs: number;
  remaining: number;
}

export class SlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();

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
      const oldest = events[0];
      const retryAfterMs = Math.max(0, oldest + this.windowMs - ts);
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    return { allowed: true, retryAfterMs: 0, remaining: this.limit - events.length };
  }

  record(key: string): void {
    const ts = this.now();
    const cutoff = ts - this.windowMs;
    const events = this.prune(key, cutoff);
    events.push(ts);
    this.buckets.set(key, events);
  }

  reserve(key: string): RateLimiterCheck {
    const result = this.check(key);
    if (!result.allowed) {
      return result;
    }
    this.record(key);
    return { ...result, remaining: Math.max(0, result.remaining - 1) };
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
      return;
    }
    this.buckets.delete(key);
  }

  private prune(key: string, cutoff: number): number[] {
    const existing = this.buckets.get(key) ?? [];
    let firstFresh = 0;
    while (firstFresh < existing.length && existing[firstFresh] <= cutoff) {
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
