import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '@betterdb/shared';
import { ActorResolver } from '../actor-resolver';
import { isActorOptionalPath, isPublicPath } from './public-paths';

export type RequestWithActor = FastifyRequest & { actor: Actor | null };

@Injectable()
export class ActorGuard implements CanActivate {
  constructor(private readonly resolver: ActorResolver) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    request.actor = null;
    if (this.resolver.isEnabled() === false) {
      return true;
    }
    if (isPublicPath(request.url, request.method) === true) {
      if (isActorOptionalPath(request.url) === true) {
        request.actor = await this.optionalActor(request);
      }
      return true;
    }
    if (this.resolver.isReady() === false) {
      throw new ServiceUnavailableException('Workspace auth is not initialised');
    }
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    const { actor, setCookies } = await this.resolver.resolveSessionFromHeaders(
      request.headers,
      request.ip,
    );
    this.forwardSetCookies(setCookies, reply);
    if (actor !== null) {
      request.actor = actor;
      return true;
    }
    const bearerActor = await this.resolver.resolveBearer(request.headers);
    if (bearerActor !== null) {
      request.actor = bearerActor;
      return true;
    }
    throw new UnauthorizedException('Sign in required');
  }

  private forwardSetCookies(cookies: string[], reply: FastifyReply): void {
    if (cookies.length === 0) {
      return;
    }
    reply.header('set-cookie', cookies);
  }

  private async optionalActor(request: RequestWithActor): Promise<Actor | null> {
    const hasCookie = typeof request.headers.cookie === 'string';
    const hasAuthorization = typeof request.headers.authorization === 'string';
    if (hasCookie === false && hasAuthorization === false) {
      return null;
    }
    try {
      return await this.resolver.resolveFromHeaders(request.headers, request.ip);
    } catch {
      return null;
    }
  }
}
