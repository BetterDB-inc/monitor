import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WorkspaceMe } from '@betterdb/shared';
import { CLIENT_IP_HEADER } from '../auth/better-auth.factory';
import { toWebHeaders } from '../auth/web-headers';
import { UsageTelemetryService } from '../telemetry/usage-telemetry.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { InvitationPreview, InvitationService } from './invitation.service';
import { MemberService } from './member.service';

export const SIGN_IN_FAILED_MESSAGE = 'Sign-in failed';

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

@Controller('invite')
export class InviteController {
  private readonly logger = new Logger(InviteController.name);

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
      await this.rollBack(invitation.id, createdId);
      throw error;
    }
    await this.telemetry.trackInviteAccepted({ role: invitation.role, method: 'password' });
    const cookies = session.headers.getSetCookie();
    if (cookies.length > 0) {
      reply.header('set-cookie', cookies);
    }
    reply.status(201).send(created);
  }

  private async rollBack(invitationId: string, createdId: string | null): Promise<void> {
    if (createdId !== null) {
      try {
        await this.members.remove(createdId);
      } catch (rollbackError) {
        this.logger.error(
          `Failed to roll back member ${createdId} after a failed invitation acceptance: ` +
            `${describeError(rollbackError)}. Invitation ${invitationId} stays accepted.`,
        );
        return;
      }
    }
    await this.invitations.release(invitationId);
  }
}
