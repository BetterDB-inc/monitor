import { Controller, Get, Post, Body, Param, UseGuards, BadRequestException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { AdminGuard } from '../admin/admin.guard';
import { OfflineLicenseService } from './offline-license.service';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * License endpoints consumed by the betterdb-website /account/licenses page,
 * authenticated with the same admin bearer token the website already uses.
 * The website is responsible for verifying the end user's session; it passes
 * the session email through, and issuance re-checks ownership against it.
 *
 * SkipThrottle: these are AdminGuard-bearer-authed internal endpoints (only the
 * website server calls them) reached via a single shared proxy/gateway IP, so
 * the global IP-keyed throttle would just make concurrent customers 429 each
 * other without adding protection. Per-user rate limiting, if wanted, belongs
 * at the website edge where the real client is known.
 */
@Controller('admin')
@UseGuards(AdminGuard)
@SkipThrottle()
export class OfflineLicenseController {
  constructor(private readonly offlineLicense: OfflineLicenseService) {}

  @Get('customers/by-email/:email/licenses')
  listCustomerLicenses(@Param('email') email: string) {
    if (!EMAIL_REGEX.test(email)) {
      throw new BadRequestException('Valid email is required');
    }
    return this.offlineLicense.listLicensesByEmail(email);
  }

  @Post('licenses/:id/offline-file')
  issueOfflineFile(@Param('id') id: string, @Body() body: { requestedByEmail: string }) {
    if (!body?.requestedByEmail || !EMAIL_REGEX.test(body.requestedByEmail)) {
      throw new BadRequestException('requestedByEmail is required');
    }
    return this.offlineLicense.issueOfflineToken(id, body.requestedByEmail);
  }

  @Post('licenses/:id/key')
  revealKey(@Param('id') id: string, @Body() body: { requestedByEmail: string }) {
    if (!body?.requestedByEmail || !EMAIL_REGEX.test(body.requestedByEmail)) {
      throw new BadRequestException('requestedByEmail is required');
    }
    return this.offlineLicense.revealLicenseKey(id, body.requestedByEmail);
  }
}
