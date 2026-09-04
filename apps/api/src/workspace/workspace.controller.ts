import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Actor, WorkspaceMe } from '@betterdb/shared';
import { ActivityService } from '../activity/activity.service';
import { CurrentUser } from '../auth/guards/current-user.decorator';
import { OwnerOnly, Roles } from '../auth/guards/roles.decorator';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { ActivityPageView, parseIsoTime, toActivityView } from './activity-views';
import { ActivityQueryDto } from './dto/activity-query.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { InvitationService } from './invitation.service';
import { MemberRecord, MemberService } from './member.service';
import { InvitationView, MemberView, toInvitationView, toMemberView } from './workspace-views';

export const CANNOT_REMOVE_SELF_MESSAGE = 'Cannot remove yourself';
export const CANNOT_REMOVE_OWNER_MESSAGE = 'Cannot remove the owner';
export const CANNOT_CHANGE_OWN_ROLE_MESSAGE = 'Cannot change your own role';
export const CANNOT_CHANGE_OWNER_ROLE_MESSAGE = "Cannot change the owner's role";
export const ALREADY_OWNER_MESSAGE = 'User is already the owner';
export const MEMBER_NOT_FOUND_MESSAGE = 'Member not found';

interface OkResponse {
  ok: true;
}

function requestOrigin(req: FastifyRequest): string | null {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    return origin;
  }
  const host = req.headers.host;
  if (host === undefined || host.length === 0) {
    return null;
  }
  return `${req.protocol}://${host}`;
}

@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly members: MemberService,
    private readonly invitations: InvitationService,
    private readonly telemetry: UsageTelemetryService,
    private readonly activity: ActivityService,
  ) {}

  @Get('me')
  async getMe(@CurrentUser() actor: Actor): Promise<WorkspaceMe> {
    const member = await this.members.findById(actor.userId);
    return {
      userId: actor.userId,
      email: actor.email,
      name: member?.name ?? null,
      role: actor.role,
      isOwner: actor.isOwner,
    };
  }

  @Get('members')
  async listMembers(): Promise<MemberView[]> {
    const members = await this.members.list();
    return members.map(toMemberView);
  }

  @Get('invitations')
  @Roles('admin')
  async listInvitations(): Promise<InvitationView[]> {
    const invitations = await this.invitations.list();
    return invitations.map(toInvitationView);
  }

  @Get('activity')
  @Roles('admin')
  async listActivity(@Query() query: ActivityQueryDto): Promise<ActivityPageView> {
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
  @Roles('admin')
  async invite(
    @Body() body: InviteMemberDto,
    @CurrentUser() actor: Actor,
    @Req() req: FastifyRequest,
  ): Promise<InvitationView & { url: string }> {
    const { invitation, token } = await this.invitations.create({
      email: body.email,
      role: body.role,
      invitedBy: actor.userId,
    });
    await this.telemetry.trackUserInvited({ role: invitation.role });
    return {
      ...toInvitationView(invitation),
      url: this.invitations.inviteUrl(token, requestOrigin(req)),
    };
  }

  @Delete('invitations/:id')
  @Roles('admin')
  async revokeInvitation(@Param('id') id: string): Promise<OkResponse> {
    await this.invitations.revoke(id);
    return { ok: true };
  }

  @Delete('members/:userId')
  @OwnerOnly()
  async removeMember(
    @Param('userId') userId: string,
    @CurrentUser() actor: Actor,
  ): Promise<OkResponse> {
    if (userId === actor.userId) {
      throw new BadRequestException(CANNOT_REMOVE_SELF_MESSAGE);
    }
    const member = await this.requireMember(userId);
    if (member.isOwner === true) {
      throw new ForbiddenException(CANNOT_REMOVE_OWNER_MESSAGE);
    }
    await this.members.remove(userId);
    return { ok: true };
  }

  @Patch('members/:userId/role')
  @OwnerOnly()
  async updateRole(
    @Param('userId') userId: string,
    @Body() body: UpdateMemberRoleDto,
    @CurrentUser() actor: Actor,
  ): Promise<MemberView> {
    if (userId === actor.userId) {
      throw new BadRequestException(CANNOT_CHANGE_OWN_ROLE_MESSAGE);
    }
    const member = await this.requireMember(userId);
    if (member.isOwner === true) {
      throw new BadRequestException(CANNOT_CHANGE_OWNER_ROLE_MESSAGE);
    }
    await this.members.setRole(userId, body.role);
    return toMemberView({ ...member, role: body.role });
  }

  @Post('ownership/transfer')
  @OwnerOnly()
  async transferOwnership(
    @Body() body: TransferOwnershipDto,
    @CurrentUser() actor: Actor,
  ): Promise<OkResponse> {
    if (body.userId === actor.userId) {
      throw new BadRequestException(ALREADY_OWNER_MESSAGE);
    }
    const member = await this.requireMember(body.userId);
    if (member.isOwner === true) {
      throw new BadRequestException(ALREADY_OWNER_MESSAGE);
    }
    await this.members.transferOwnership(actor.userId, body.userId);
    return { ok: true };
  }

  private async requireMember(userId: string): Promise<MemberRecord> {
    const member = await this.members.findById(userId);
    if (member === null) {
      throw new NotFoundException(MEMBER_NOT_FOUND_MESSAGE);
    }
    return member;
  }
}
