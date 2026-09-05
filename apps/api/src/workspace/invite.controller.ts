import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceMe } from '@betterdb/shared';
import { ActivityService } from '../activity/activity.service';
import { CLIENT_IP_HEADER } from '../auth/better-auth.factory';
import { toWebHeaders } from '../auth/web-headers';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { InvitationPreview, InvitationService } from './invitation.service';
import { MemberService } from './member.service';

export const SIGN_IN_FAILED_MESSAGE = 'Sign-in failed';

@Controller('invite')
export class InviteController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly members: MemberService,
    private readonly telemetry: UsageTelemetryService,
    private readonly activity: ActivityService,
  ) {}

  @Get(':token')
  preview(@Param('token') token: string): Promise<InvitationPreview> {
    return this.invitations.preview(token);
  }

  @Post(':token/accept')
  async accept(
    @Param('token') token: string,
    @Body() body: AcceptInviteDto,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const invitation = await this.invitations.claim(token);
    let created: WorkspaceMe;
    let session: Response;
    let createdId: string | null = null;
    try {
      const member = await this.members.create({
        email: invitation.email,
        name: body.name,
        password: body.password,
        role: invitation.role,
      });
      createdId = member.id;
      created = {
        userId: member.id,
        email: member.email,
        name: member.name,
        role: member.role,
        isOwner: member.isOwner,
      };
      const headers = toWebHeaders(req.headers);
      headers.set(CLIENT_IP_HEADER, req.ip);
      session = await this.members.signIn(member.email, body.password, headers);
      if (session.ok === false) {
        throw new UnauthorizedException(SIGN_IN_FAILED_MESSAGE);
      }
    } catch (error) {
      if (createdId !== null) {
        try {
          await this.members.remove(createdId);
        } catch (rollbackError) {
          void rollbackError;
        }
      }
      await this.invitations.release(invitation.id);
      throw error;
    }
    await this.telemetry.trackInviteAccepted({ role: invitation.role, method: 'password' });
    void this.activity.record({
      actor: { userId: created.userId, email: created.email, via: 'session', tokenId: null },
      action: 'auth.login',
      statusCode: 201,
      ip: req.ip,
      details: { method: 'invite' },
    });
    const cookies = session.headers.getSetCookie();
    if (cookies.length > 0) {
      reply.header('set-cookie', cookies);
    }
    reply.status(201).send(created);
  }
}
