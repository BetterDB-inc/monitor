import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';

interface ValidateBody {
  licenseKey: string;
  stats?: Record<string, any>;
}

@Controller('v1/entitlements')
export class EntitlementController {
  constructor(private readonly entitlement: EntitlementService) {}

  @Post()
  async validate(@Body() body: ValidateBody) {
    if (!body.licenseKey || typeof body.licenseKey !== 'string') {
      throw new BadRequestException('licenseKey is required');
    }

    if (body.licenseKey.length < 10 || body.licenseKey.length > 100) {
      throw new BadRequestException('Invalid license key format');
    }

    return this.entitlement.validateLicense(body);
  }
}
