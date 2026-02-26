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
import { InvitationService } from './invitation.service';
import { AdminGuard } from '../admin/admin.guard';
import { CreateInvitationDto, AcceptInvitationDto } from './dto';

@Controller('invitations')
@UseGuards(AdminGuard)
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
