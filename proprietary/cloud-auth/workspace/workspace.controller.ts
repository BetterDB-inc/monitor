import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { EntitlementClientService } from './entitlement-client.service';
import { ActivityService } from '../../../apps/api/src/activity/activity.service';
import { ActivityQueryDto } from '../../../apps/api/src/workspace/dto/activity-query.dto';
import {
  ActivityPageView,
  parseIsoTime,
  toActivityView,
} from '../../../apps/api/src/workspace/activity-views';

@Controller('workspace')
export class WorkspaceController {
  private readonly tenantId: string;

  constructor(
    private readonly entitlementClient: EntitlementClientService,
    private readonly activity: ActivityService,
  ) {
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

  /**
   * The workspace tenant an id-addressed mutation must be scoped to. Fails
   * closed on an empty tenant: the entitlement server's tenant guard is
   * truthiness-based, so sending `?tenantId=` would make it skip the check
   * and run the mutation unscoped (GHSA-2rwf-9ffp-8pf2). A pod with neither
   * TENANT_ID nor a session tenant has no business mutating by id.
   */
  private requireTenantId(cloudUser: any): string {
    const tenantId = this.tenantId || cloudUser.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No workspace tenant for this request');
    }
    return tenantId;
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

  @Get('activity')
  async getActivity(
    @Req() req: FastifyRequest,
    @Query() query: ActivityQueryDto,
  ): Promise<ActivityPageView> {
    const cloudUser = this.getCloudUser(req);
    this.requireAdminOrOwner(cloudUser);
    const page = await this.activity.list({
      actorUserId: query.actor,
      from: parseIsoTime(query.from),
      to: parseIsoTime(query.to),
      action: query.action,
      cursor: query.cursor,
      limit: query.limit,
    });
    return { items: page.items.map(toActivityView), nextCursor: page.nextCursor };
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
    // Scope to the caller's workspace so an owner can't revoke another
    // tenant's invitation by id (same pattern as the database handlers).
    const tenantId = this.requireTenantId(cloudUser);
    return this.entitlementClient.revokeInvitation(id, tenantId);
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

    // Scope to the caller's workspace so an owner can't delete another
    // tenant's user by id (same pattern as the database handlers).
    const tenantId = this.requireTenantId(cloudUser);
    return this.entitlementClient.deleteUser(userId, tenantId);
  }

  @Get('databases')
  async listDatabases(@Req() req: FastifyRequest) {
    const cloudUser = this.getCloudUser(req);
    const tenantId = this.tenantId || cloudUser.tenantId;
    return this.entitlementClient.listValkeyInstances(tenantId);
  }

  @Post('databases')
  async createDatabase(
    @Req() req: FastifyRequest,
    @Body() body: { name: string; maxmemory?: string },
  ) {
    const cloudUser = this.getCloudUser(req);
    this.requireAdminOrOwner(cloudUser);

    if (!body.name) {
      throw new BadRequestException('Name is required');
    }

    const tenantId = this.tenantId || cloudUser.tenantId;
    return this.entitlementClient.createValkeyInstance({
      tenantId,
      name: body.name,
      maxmemory: body.maxmemory,
    });
  }

  @Get('databases/:id/credentials')
  async getDatabaseCredentials(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ) {
    const cloudUser = this.getCloudUser(req);
    this.requireAdminOrOwner(cloudUser);
    const tenantId = this.tenantId || cloudUser.tenantId;
    return this.entitlementClient.getValkeyInstanceCredentials(id, tenantId);
  }

  @Delete('databases/:id')
  async deleteDatabase(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
  ) {
    const cloudUser = this.getCloudUser(req);
    this.requireAdminOrOwner(cloudUser);
    const tenantId = this.tenantId || cloudUser.tenantId;
    return this.entitlementClient.deleteValkeyInstance(id, tenantId);
  }
}
