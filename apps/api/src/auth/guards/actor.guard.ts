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
import { isPublicPath } from './public-paths';

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
    throw new UnauthorizedException('Sign in required');
  }

  private forwardSetCookies(cookies: string[], reply: FastifyReply): void {
    if (cookies.length === 0) {
      return;
    }
    reply.header('set-cookie', cookies);
  }
}
