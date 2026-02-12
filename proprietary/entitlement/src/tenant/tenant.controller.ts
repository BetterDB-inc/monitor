import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { TenantService } from './tenant.service';
import { AdminGuard } from '../admin/admin.guard';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { ListTenantsDto } from './dto/list-tenants.dto';

@Controller('tenants')
@UseGuards(AdminGuard)
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Post()
  createTenant(@Body(new ValidationPipe({ whitelist: true })) dto: CreateTenantDto) {
    return this.tenantService.createTenant(dto);
  }

  @Get()
  listTenants(@Query(new ValidationPipe({ whitelist: true, transform: true })) query: ListTenantsDto) {
    return this.tenantService.listTenants(query);
  }

  @Get('by-subdomain/:subdomain')
  getTenantBySubdomain(@Param('subdomain') subdomain: string) {
    return this.tenantService.getTenantBySubdomain(subdomain);
  }

  @Get(':id')
  getTenant(@Param('id') id: string) {
    return this.tenantService.getTenant(id);
  }

  @Patch(':id')
  updateTenant(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: UpdateTenantDto,
  ) {
    return this.tenantService.updateTenant(id, dto);
  }

  @Delete(':id')
  deleteTenant(@Param('id') id: string) {
    return this.tenantService.deleteTenant(id);
  }
}
