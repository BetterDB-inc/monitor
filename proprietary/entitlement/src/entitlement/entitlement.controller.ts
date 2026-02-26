import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import type { EntitlementRequest, EntitlementResponse } from '@betterdb/shared';

const LICENSE_KEY_MIN_LENGTH = 10;
const LICENSE_KEY_MAX_LENGTH = 100;

@Controller('v1/entitlements')
export class EntitlementController {
  constructor(private readonly entitlement: EntitlementService) {}

  @Post()
  async validate(@Body() body: EntitlementRequest): Promise<EntitlementResponse> {
    // If no license key provided, handle as keyless instance
    if (!body.licenseKey || body.licenseKey === '') {
      return this.entitlement.handleKeylessInstance(body);
    }

    // Validate license key format only when a key IS provided
    if (body.licenseKey.length < LICENSE_KEY_MIN_LENGTH || body.licenseKey.length > LICENSE_KEY_MAX_LENGTH) {
      throw new BadRequestException('Invalid license key format');
    }

    return this.entitlement.validateLicense(body);
  }
}
