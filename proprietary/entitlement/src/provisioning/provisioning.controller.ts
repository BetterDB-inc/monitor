import {
  Controller,
  Post,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { AdminGuard } from '../admin/admin.guard';

@Controller('tenants')
@UseGuards(AdminGuard)
export class ProvisioningController {
  private readonly logger = new Logger(ProvisioningController.name);

  constructor(private readonly provisioningService: ProvisioningService) {}

  @Post(':id/provision')
  @HttpCode(HttpStatus.ACCEPTED)
  async provisionTenant(@Param('id') id: string) {
    this.logger.log(`Received provision request for tenant ${id}`);

    // Run provisioning asynchronously - don't block the HTTP request
    this.provisioningService.provisionTenant(id).catch((error) => {
      this.logger.error(`Async provisioning failed for tenant ${id}: ${error.message}`);
    });

    return {
      message: 'Provisioning started',
      tenantId: id,
      status: 'provisioning',
    };
  }

  @Post(':id/deprovision')
  @HttpCode(HttpStatus.ACCEPTED)
  async deprovisionTenant(@Param('id') id: string) {
    this.logger.log(`Received deprovision request for tenant ${id}`);

    // Run deprovisioning asynchronously - don't block the HTTP request
    this.provisioningService.deprovisionTenant(id).catch((error) => {
      this.logger.error(`Async deprovisioning failed for tenant ${id}: ${error.message}`);
    });

    return {
      message: 'Deprovisioning started',
      tenantId: id,
      status: 'deleting',
    };
  }
}
