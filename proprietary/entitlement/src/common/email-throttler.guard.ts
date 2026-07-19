import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

const REGISTRATION_ROUTE = '/v1/registrations';

/**
 * Rate-limits ONLY the public registration route, keyed on the TARGET email.
 *
 * Every endpoint on this service is reached through betterdb.com → API Gateway
 * → VPC link, so the peer IP is a single shared value. An IP-keyed throttle is
 * therefore a GLOBAL cap, not a per-client one — applied to the control-plane
 * routes (tenant/user/auth/provision) it strangles signup, workspace login and
 * license checks fleet-wide once a handful of requests land in the same window.
 * (This is exactly what took the control plane down: a global 20/60s IP limit
 * 429'd every signup.) So we SKIP throttling everywhere except registration.
 *
 * Registration is the one genuinely abuse-prone public route (it emails the
 * given address — an email-bombing vector), and we have that address in the
 * body, so we key its limit on the target email: per-victim caps without ever
 * blocking distinct legitimate signups behind the shared IP.
 */
@Injectable()
export class EmailThrottlerGuard extends ThrottlerGuard {
  // Skip throttling for every route except registration. Centralising the
  // decision here (rather than @SkipThrottle on each controller) means new
  // control-plane routes are never accidentally caught by the global limit.
  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const url: string = req?.url ?? '';
    return !url.includes(REGISTRATION_ROUTE);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const email = req?.body?.email;
    if (typeof email === 'string' && email.trim()) {
      return `reg:${email.trim().toLowerCase()}`;
    }
    return req?.ip ?? 'unknown';
  }
}
