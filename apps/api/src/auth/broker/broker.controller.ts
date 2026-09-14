import { Controller, Get, Inject, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  BROKER_SIGN_IN_PATH,
  type BrokerProvider,
  type BrokerTokenClaims,
  isBrokerProvider,
} from '@betterdb/shared';
import { ActivityService } from '../../activity/activity.service';
import { UsageTelemetryService } from '../../telemetry/usage-telemetry.service';
import {
  BrokerNotInvitedError,
  BrokerUserResolver,
  ResolvedBrokerUser,
} from '../../workspace/broker-user-resolver.service';
import { hashInvitationToken } from '../../workspace/invitation.service';
import { MemberService } from '../../workspace/member.service';
import { CLIENT_IP_HEADER } from '../better-auth.factory';
import { toWebHeaders } from '../web-headers';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '../workspace-config';
import { BrokerTokenError, verifyBrokerToken } from './broker-token.verifier';
import { BrokerStateStore } from './broker-state.store';
import { safeNext } from './safe-next';

type BrokerErrorCode = 'invalid' | 'expired' | 'not_invited';

function trimTrailingSlash(value: string): string {
  if (value.endsWith('/') === true) {
    return value.slice(0, -1);
  }
  return value;
}

@Controller('auth/broker')
export class BrokerController {
  constructor(
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
    private readonly states: BrokerStateStore,
    private readonly resolver: BrokerUserResolver,
    private readonly members: MemberService,
    private readonly activity: ActivityService,
    private readonly telemetry: UsageTelemetryService,
  ) {}

  @Get('start')
  async start(
    @Query('provider') provider: unknown,
    @Query('next') next: unknown,
    @Query('invite') invite: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (this.config.brokerEnabled === false) {
      reply.status(404).send();
      return;
    }
    const origin = this.callbackOrigin(req);
    const inviteTokenHash =
      typeof invite === 'string' && invite.length > 0 ? hashInvitationToken(invite) : null;
    const state = await this.states.create({
      origin,
      appOrigin: this.appOrigin(req),
      next: safeNext(next),
      inviteTokenHash,
    });
    const target = new URL(BROKER_SIGN_IN_PATH, this.config.brokerUrl);
    target.searchParams.set('redirect', `${origin}${this.config.basePath}/broker/callback`);
    target.searchParams.set('state', state);
    if (isBrokerProvider(provider) === true) {
      target.searchParams.set('provider', provider);
    }
    reply.redirect(target.toString(), 302);
  }

  @Get('callback')
  async callback(
    @Query('token') token: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    if (this.config.brokerEnabled === false) {
      reply.status(404).send();
      return;
    }
    const fallbackApp = this.appOrigin(req);
    if (typeof token !== 'string' || token.length === 0) {
      this.fail(reply, fallbackApp, 'invalid');
      return;
    }
    let claims: BrokerTokenClaims;
    try {
      claims = verifyBrokerToken(token, this.config.brokerKeys);
    } catch (error) {
      if (error instanceof BrokerTokenError) {
        this.fail(reply, fallbackApp, 'invalid');
        return;
      }
      throw error;
    }
    const state = await this.states.consume(claims.state);
    if (state === null) {
      this.fail(reply, fallbackApp, 'expired');
      return;
    }
    if (claims.aud !== state.origin) {
      this.fail(reply, state.appOrigin, 'invalid');
      return;
    }
    let resolved: ResolvedBrokerUser;
    try {
      resolved = await this.resolver.resolve(
        {
          email: claims.email,
          name: claims.name,
          avatarUrl: claims.avatarUrl,
          provider: claims.provider,
          providerId: claims.providerId,
        },
        state.inviteTokenHash,
      );
    } catch (error) {
      if (error instanceof BrokerNotInvitedError) {
        this.fail(reply, state.appOrigin, 'not_invited');
        return;
      }
      throw error;
    }
    const headers = toWebHeaders(req.headers);
    headers.set(CLIENT_IP_HEADER, req.ip);
    const session = await this.members.startSession(resolved.member.id, headers);
    if (session.ok === false) {
      this.fail(reply, state.appOrigin, 'invalid');
      return;
    }
    this.record(req, resolved, claims.provider);
    const cookies = session.headers.getSetCookie();
    if (cookies.length > 0) {
      reply.header('set-cookie', cookies);
    }
    reply.redirect(`${state.appOrigin}${state.next}`, 302);
  }

  private record(
    req: FastifyRequest,
    resolved: ResolvedBrokerUser,
    provider: BrokerProvider,
  ): void {
    const method = resolved.entrance === 'login' ? provider : resolved.entrance;
    void this.activity.record({
      actor: {
        userId: resolved.member.id,
        email: resolved.member.email,
        via: 'session',
        tokenId: null,
      },
      action: 'auth.login',
      statusCode: 302,
      ip: req.ip,
      details: { method, provider },
    });
    if (resolved.entrance === 'register') {
      void this.telemetry.trackWorkspaceFirstRegister({ method: provider });
      return;
    }
    if (resolved.entrance === 'invite') {
      void this.telemetry.trackInviteAccepted({ role: resolved.member.role, method: provider });
      return;
    }
    void this.telemetry.trackUserLogin({ method: provider });
  }

  private fail(reply: FastifyReply, appOrigin: string, code: BrokerErrorCode): void {
    reply.redirect(`${appOrigin}/login?error=${code}`, 302);
  }

  private requestOrigin(req: FastifyRequest): string {
    const host = req.host === '' ? 'localhost' : req.host;
    return `${req.protocol}://${host}`;
  }

  private callbackOrigin(req: FastifyRequest): string {
    if (this.config.publicUrl !== null) {
      return new URL(this.config.publicUrl).origin;
    }
    return this.requestOrigin(req);
  }

  private appOrigin(req: FastifyRequest): string {
    if (this.config.publicUrl !== null) {
      return trimTrailingSlash(this.config.publicUrl);
    }
    if (this.config.devAppOrigin !== null) {
      return this.config.devAppOrigin;
    }
    return this.requestOrigin(req);
  }
}
