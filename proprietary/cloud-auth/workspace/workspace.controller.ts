import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { EntitlementClientService } from './entitlement-client.service';

@Controller('workspace')
export class WorkspaceController {
  private readonly tenantId: string;

  constructor(private readonly entitlementClient: EntitlementClientService) {
    this.tenantId = process.env.TENANT_ID || '';
  }

  private getCloudUser(req: FastifyRequest) {
    const cloudUser = (req as any).cloudUser;
    if (!cloudUser) {
      throw new ForbiddenException('Not authenticated');
    }
    return cloudUser;
  }

  private requireAdminOrOwner(cloudUser: any) {
    if (cloudUser.role !== 'admin' && cloudUser.role !== 'owner') {
      throw new ForbiddenException('Admin or owner access required');
    }
  }

  private requireOwner(cloudUser: any) {
    if (cloudUser.role !== 'owner') {
      throw new ForbiddenException('Owner access required');
    }
  }

  @Get('me')
  getMe(@Req() req: FastifyRequest) {
    const cloudUser = this.getCloudUser(req);
    return {
      userId: cloudUser.userId,
      email: cloudUser.email,
      tenantId: cloudUser.tenantId,
      subdomain: cloudUser.subdomain,
      role: cloudUser.role,
    };
  }

  @Get('members')
  async getMembers(@Req() req: FastifyRequest) {
    const cloudUser = this.getCloudUser(req);
    const tenantId = this.tenantId || cloudUser.tenantId;
    return this.entitlementClient.getMembers(tenantId);
  }

  @Post('invite')
  async invite(
    @Req() req: FastifyRequest,
    @Body() body: { email: string; role: string },
  ) {
    const cloudUser = this.getCloudUser(req);
    this.requireAdminOrOwner(cloudUser);

    if (!body.email) {
      throw new BadRequestException('Email is required');
    }

    const tenantId = this.tenantId || cloudUser.tenantId;
    return this.entitlementClient.createInvitation({
      tenantId,
      email: body.email,
      role: body.role || 'member',
      invitedBy: cloudUser.userId,
    });
  }

  @Get('invitations')
  async getInvitations(@Req() req: FastifyRequest) {
    const cloudUser = this.getCloudUser(req);
    this.requireAdminOrOwner(cloudUser);

    const tenantId = this.tenantId || cloudUser.tenantId;
    return this.entitlementClient.listInvitations(tenantId);
  }

  @Delete('invitations/:id')
  async revokeInvitation(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ) {
    const cloudUser = this.getCloudUser(req);
    this.requireAdminOrOwner(cloudUser);
    return this.entitlementClient.revokeInvitation(id);
  }

  @Delete('members/:userId')
  async removeMember(
    @Req() req: FastifyRequest,
    @Param('userId') userId: string,
  ) {
    const cloudUser = this.getCloudUser(req);
    this.requireOwner(cloudUser);

    if (userId === cloudUser.userId) {
      throw new BadRequestException('Cannot remove yourself');
    }

    return this.entitlementClient.deleteUser(userId);
  }
}
