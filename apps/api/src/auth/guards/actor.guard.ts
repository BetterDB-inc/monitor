import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import type { Actor, WorkspaceRole } from '@betterdb/shared';
import { BETTER_AUTH, CLIENT_IP_HEADER, type BetterAuthInstance } from '../better-auth.factory';
import { toWebHeaders } from '../web-headers';
import { WORKSPACE_CONFIG, type WorkspaceConfig } from '../workspace-config';
import { isPublicPath } from './public-paths';

export type RequestWithActor = FastifyRequest & { actor: Actor | null };

interface SessionUserShape {
  id: string;
  email: string;
  role?: unknown;
  isOwner?: unknown;
}

@Injectable()
export class ActorGuard implements CanActivate {
  private readonly auth: BetterAuthInstance | null;

  constructor(
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
    @Optional() @Inject(BETTER_AUTH) auth?: BetterAuthInstance | null,
  ) {
    this.auth = auth ?? null;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    request.actor = null;
    if (this.config.enabled === false) {
      return true;
    }
    if (isPublicPath(request.url, request.method)) {
      return true;
    }
    if (this.auth === null) {
      throw new ServiceUnavailableException('Workspace auth is not initialised');
    }
    const actor = await this.resolveSessionActor(request);
    if (actor !== null) {
      request.actor = actor;
      return true;
    }
    throw new UnauthorizedException('Sign in required');
  }

  private async resolveSessionActor(request: FastifyRequest): Promise<Actor | null> {
    if (this.auth === null) {
      return null;
    }
    const headers = toWebHeaders(request.headers);
    headers.set(CLIENT_IP_HEADER, request.ip);
    const session = await this.auth.api.getSession({ headers });
    if (session === null) {
      return null;
    }
    const user = session.user as SessionUserShape;
    return {
      userId: user.id,
      email: user.email,
      role: user.role === 'admin' ? 'admin' : ('member' as WorkspaceRole),
      isOwner: user.isOwner === true,
      via: 'session',
      tokenId: null,
    };
  }
}
