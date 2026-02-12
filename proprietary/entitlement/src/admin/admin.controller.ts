import { Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_TIERS = ['community', 'pro', 'enterprise'];

@Controller('admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Post('customers')
  createCustomer(@Body() body: { email: string; name?: string }) {
    if (!body.email || !EMAIL_REGEX.test(body.email)) {
      throw new BadRequestException('Valid email is required');
    }
    if (body.name && (typeof body.name !== 'string' || body.name.length > 200)) {
      throw new BadRequestException('Invalid name');
    }
    return this.admin.createCustomer(body);
  }

  @Get('customers')
  listCustomers(@Query('skip') skip?: string, @Query('take') take?: string) {
    return this.admin.listCustomers({
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('customers/:id')
  getCustomer(@Param('id') id: string) {
    return this.admin.getCustomer(id);
  }

  @Post('licenses')
  createLicense(
    @Body() body: { customerId: string; tier: string; instanceLimit?: number; expiresAt?: string },
  ) {
    if (!body.customerId || typeof body.customerId !== 'string') {
      throw new BadRequestException('customerId is required');
    }
    if (!body.tier || !VALID_TIERS.includes(body.tier)) {
      throw new BadRequestException(`tier must be one of: ${VALID_TIERS.join(', ')}`);
    }
    if (body.instanceLimit !== undefined && (typeof body.instanceLimit !== 'number' || body.instanceLimit < 1)) {
      throw new BadRequestException('instanceLimit must be a positive number');
    }
    if (body.expiresAt && isNaN(Date.parse(body.expiresAt))) {
      throw new BadRequestException('expiresAt must be a valid date');
    }
    return this.admin.createLicense({
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
  }

  @Get('licenses')
  listLicenses(
    @Query('customerId') customerId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.admin.listLicenses({
      customerId,
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('licenses/:id')
  getLicense(@Param('id') id: string) {
    return this.admin.getLicense(id);
  }

  @Put('licenses/:id')
  updateLicense(
    @Param('id') id: string,
    @Body() body: { active?: boolean; expiresAt?: string; instanceLimit?: number },
  ) {
    return this.admin.updateLicense(id, {
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
  }

  @Delete('licenses/:id')
  deleteLicense(@Param('id') id: string) {
    return this.admin.deleteLicense(id);
  }

  @Get('licenses/:id/stats')
  getLicenseStats(@Param('id') id: string) {
    return this.admin.getLicenseStats(id);
  }
}
