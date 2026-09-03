import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceMe } from '@betterdb/shared';
import { toWebHeaders } from '../auth/web-headers';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { InvitationPreview, InvitationService } from './invitation.service';
import { MemberService } from './member.service';

@Controller('invite')
export class InviteController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly members: MemberService,
    private readonly telemetry: UsageTelemetryService,
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
    try {
      const member = await this.members.create({
        email: invitation.email,
        name: body.name,
        password: body.password,
        role: invitation.role,
      });
      created = {
        userId: member.id,
        email: member.email,
        name: member.name,
        role: member.role,
        isOwner: member.isOwner,
      };
      session = await this.members.signIn(member.email, body.password, toWebHeaders(req.headers));
    } catch (error) {
      await this.invitations.release(invitation.id);
      throw error;
    }
    await this.telemetry.trackInviteAccepted({ role: invitation.role, method: 'password' });
    const cookies = session.headers.getSetCookie();
    if (cookies.length > 0) {
      reply.header('set-cookie', cookies);
    }
    reply.status(201).send(created);
  }
}
