import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RegistrationService } from './registration.service';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Controller('v1/registrations')
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) { }

  @Post()
  // Per-TARGET-EMAIL cap (see EmailThrottlerGuard): each call emails the given
  // address, so an open endpoint is an email-bombing vector. Keyed on the email
  // rather than the peer IP, which is a single shared proxy address here — an
  // IP limit would throttle all signups globally instead of per victim.
  @Throttle({ default: { ttl: 3600000, limit: 3 } })
  async register(
    @Body() body: { email: string },
  ): Promise<{ message: string }> {
    if (!body.email || typeof body.email !== 'string') {
      throw new BadRequestException('Email is required');
    }

    const email = body.email.trim().toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      throw new BadRequestException('Invalid email format');
    }

    return this.registration.register(email);
  }
}
