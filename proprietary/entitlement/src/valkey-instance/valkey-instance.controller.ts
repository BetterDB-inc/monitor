import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ValidationPipe,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ValkeyInstanceService } from './valkey-instance.service';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { AdminGuard } from '../admin/admin.guard';
import { CreateValkeyInstanceDto } from './dto/create-valkey-instance.dto';

@Controller('valkey-instances')
@UseGuards(AdminGuard)
export class ValkeyInstanceController {
  private readonly logger = new Logger(ValkeyInstanceController.name);

  constructor(
    private readonly valkeyInstances: ValkeyInstanceService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async createInstance(
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateValkeyInstanceDto,
  ) {
    const instance = await this.valkeyInstances.createInstance(dto);

    // Provision asynchronously so the request returns immediately.
    this.provisioning.provisionValkeyInstance(instance.id).catch((error) => {
      this.logger.error(
        `Async valkey provisioning failed for ${instance.id}: ${error.message}`,
      );
    });

    return instance;
  }

  @Get()
  listInstances(@Query('tenantId') tenantId: string) {
    if (!tenantId) {
      throw new BadRequestException('tenantId query parameter is required');
    }
    return this.valkeyInstances.listInstances(tenantId);
  }

  @Get(':id')
  getInstance(@Param('id') id: string) {
    return this.valkeyInstances.getInstance(id);
  }

  @Get(':id/credentials')
  async getCredentials(
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    // Scope to the caller's workspace so a tenant can't read another
    // tenant's credentials by id.
    await this.valkeyInstances.getInstanceForTenant(id, tenantId);
    return this.provisioning.getValkeyInstanceCredentials(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.ACCEPTED)
  async deleteInstance(
    @Param('id') id: string,
    @Query('tenantId') tenantId?: string,
  ) {
    const instance = await this.valkeyInstances.markForDeletion(id, tenantId);

    this.provisioning.deprovisionValkeyInstance(id).catch((error) => {
      this.logger.error(
        `Async valkey deprovisioning failed for ${id}: ${error.message}`,
      );
    });

    return instance;
  }
}
