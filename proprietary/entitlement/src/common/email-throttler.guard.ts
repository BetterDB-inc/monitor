import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Throttler that keys the public registration route on the TARGET email
 * rather than the peer IP.
 *
 * Registration reaches this service only through betterdb.com → API Gateway →
 * VPC link, so the peer IP is a single shared value — an IP-based limit would
 * apply globally to all signups. The abuse we care about is email-bombing a
 * specific address, and we already have that address in the body, so tracking
 * by email caps per-target registrations without ever blocking distinct
 * legitimate signups. Every other route keeps the default IP tracker.
 */
@Injectable()
export class EmailThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const url: string = req?.url ?? '';
    const email = req?.body?.email;
    if (url.includes('/v1/registrations') && typeof email === 'string' && email.trim()) {
      return `reg:${email.trim().toLowerCase()}`;
    }
    return req?.ip ?? 'unknown';
  }
}
