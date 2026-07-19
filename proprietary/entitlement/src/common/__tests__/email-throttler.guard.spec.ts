import { describe, it, expect } from 'vitest';
import { EmailThrottlerGuard } from '../email-throttler.guard';

// getTracker/shouldSkip are protected — exercise them via a thin subclass.
class TestGuard extends EmailThrottlerGuard {
  track(req: Record<string, any>) {
    return this.getTracker(req);
  }
  skip(req: Record<string, any>) {
    return this.shouldSkip({ switchToHttp: () => ({ getRequest: () => req }) } as any);
  }
}

describe('EmailThrottlerGuard', () => {
  const guard = Object.create(TestGuard.prototype) as TestGuard;

  describe('shouldSkip — only the registration route is throttled', () => {
    it('does NOT skip the public registration route', async () => {
      expect(await guard.skip({ url: '/v1/registrations', body: { email: 'a@b.com' } })).toBe(false);
    });

    it('SKIPS every control-plane route (shared proxy IP would make the throttle global)', async () => {
      for (const url of [
        '/tenants',
        '/users/by-email/x@y.com',
        '/auth/workspace-token',
        '/tenants/abc/provision',
        '/v1/entitlements',
        '/admin/licenses/1/offline-file',
        '/invitations/check',
      ]) {
        expect(await guard.skip({ url })).toBe(true);
      }
    });
  });

  describe('getTracker — registration is keyed on the target email', () => {
    it('keys on the normalized target email (not the shared proxy IP)', async () => {
      const a = await guard.track({ url: '/v1/registrations', ip: '10.0.0.1', body: { email: 'Victim@Example.com' } });
      const b = await guard.track({ url: '/v1/registrations', ip: '10.0.0.9', body: { email: 'victim@example.com ' } });
      expect(a).toBe('reg:victim@example.com');
      expect(a).toBe(b);
    });

    it('gives different emails different buckets (distinct signups not blocked)', async () => {
      const a = await guard.track({ url: '/v1/registrations', ip: '10.0.0.1', body: { email: 'alice@x.com' } });
      const b = await guard.track({ url: '/v1/registrations', ip: '10.0.0.1', body: { email: 'bob@x.com' } });
      expect(a).not.toBe(b);
    });

    it('falls back to IP when the registration body has no email', async () => {
      const t = await guard.track({ url: '/v1/registrations', ip: '10.0.0.5', body: {} });
      expect(t).toBe('10.0.0.5');
    });
  });
});
