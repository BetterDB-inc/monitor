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
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { InvitationService } from './invitation.service';
import { AdminGuard } from '../admin/admin.guard';
import { CreateInvitationDto, AcceptInvitationDto } from './dto';

/**
 * SkipThrottle: these are AdminGuard-bearer-authed internal endpoints (only the
 * website server calls them) reached via a single shared proxy/gateway IP, so
 * the global IP-keyed throttle would just make concurrent customers 429 each
 * other during signup/onboarding without adding protection. Per-user rate
 * limiting, if wanted, belongs at the website edge where the real client is
 * known. Mirrors OfflineLicenseController.
 */
@Controller('invitations')
@UseGuards(AdminGuard)
@SkipThrottle()
export class InvitationController {
  constructor(private readonly invitationService: InvitationService) {}

  @Post()
  create(@Body(new ValidationPipe({ whitelist: true })) dto: CreateInvitationDto) {
    return this.invitationService.create(dto);
  }

  @Get()
  listByTenant(@Query('tenantId') tenantId: string) {
    return this.invitationService.listByTenant(tenantId);
  }

  @Get('check')
  checkForEmail(
    @Query('email') email: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.invitationService.checkForEmail(email, tenantId);
  }

  @Post(':id/accept')
  accept(
    @Param('id') id: string,
    @Body(new ValidationPipe({ whitelist: true })) dto: AcceptInvitationDto,
  ) {
    return this.invitationService.accept(id, dto.userId);
  }

  @Delete(':id')
  revoke(@Param('id') id: string) {
    return this.invitationService.revoke(id);
  }
}
