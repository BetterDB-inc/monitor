import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WORKSPACE_CONFIG, WorkspaceConfig } from '../workspace-config';
import { RequestWithActor } from './actor.guard';
import { isPublicPath } from './public-paths';
import { ALLOW_MEMBERS_KEY } from './roles.decorator';

export const READ_ONLY_MESSAGE = 'Read-only members cannot make changes. Ask a workspace admin.';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class MutationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.enabled === false) {
      return true;
    }
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    if (SAFE_METHODS.has(request.method.toUpperCase()) === true) {
      return true;
    }
    if (isPublicPath(request.url, request.method) === true) {
      return true;
    }
    const actor = request.actor ?? null;
    if (actor === null) {
      throw new UnauthorizedException('Sign in required');
    }
    if (actor.role === 'admin') {
      return true;
    }
    const allowMembers = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_MEMBERS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowMembers === true) {
      return true;
    }
    throw new ForbiddenException(READ_ONLY_MESSAGE);
  }
}
