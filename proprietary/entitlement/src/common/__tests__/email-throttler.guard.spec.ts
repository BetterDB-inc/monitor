import { describe, it, expect } from 'vitest';
import { EmailThrottlerGuard } from '../email-throttler.guard';

// getTracker is protected — exercise it via a thin subclass.
class TestGuard extends EmailThrottlerGuard {
  track(req: Record<string, any>) {
    return this.getTracker(req);
  }
}

describe('EmailThrottlerGuard.getTracker', () => {
  const guard = Object.create(TestGuard.prototype) as TestGuard;

  it('keys registration on the normalized target email (not the shared proxy IP)', async () => {
    const a = await guard.track({ url: '/v1/registrations', ip: '10.0.0.1', body: { email: 'Victim@Example.com' } });
    const b = await guard.track({ url: '/v1/registrations', ip: '10.0.0.9', body: { email: 'victim@example.com ' } });
    // Same target email → same bucket regardless of (shared) IP
    expect(a).toBe('reg:victim@example.com');
    expect(a).toBe(b);
  });

  it('gives different emails different buckets (distinct signups not blocked)', async () => {
    const a = await guard.track({ url: '/v1/registrations', ip: '10.0.0.1', body: { email: 'alice@x.com' } });
    const b = await guard.track({ url: '/v1/registrations', ip: '10.0.0.1', body: { email: 'bob@x.com' } });
    expect(a).not.toBe(b);
  });

  it('falls back to IP for non-registration routes', async () => {
    const t = await guard.track({ url: '/v1/entitlements', ip: '10.0.0.5', body: { email: 'x@y.com' } });
    expect(t).toBe('10.0.0.5');
  });

  it('falls back to IP when the registration body has no email', async () => {
    const t = await guard.track({ url: '/v1/registrations', ip: '10.0.0.5', body: {} });
    expect(t).toBe('10.0.0.5');
  });
});
