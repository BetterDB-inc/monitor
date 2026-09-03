import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { WorkspaceRole } from '@betterdb/shared';
import { WORKSPACE_CONFIG, WorkspaceConfig } from '../workspace-config';
import { RequestWithActor } from './actor.guard';
import { OWNER_ONLY_KEY, ROLES_KEY } from './roles.decorator';

export const ROLE_REQUIRED_MESSAGE = 'This action requires the admin role';
export const OWNER_REQUIRED_MESSAGE = 'This action requires the workspace owner';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(WORKSPACE_CONFIG) private readonly config: WorkspaceConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.enabled === false) {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<WorkspaceRole[] | undefined>(ROLES_KEY, targets);
    const ownerOnly = this.reflector.getAllAndOverride<boolean | undefined>(
      OWNER_ONLY_KEY,
      targets,
    );
    if (roles === undefined && ownerOnly !== true) {
      return true;
    }
    const request = context.switchToHttp().getRequest<RequestWithActor>();
    const actor = request.actor ?? null;
    if (actor === null) {
      throw new UnauthorizedException('Sign in required');
    }
    if (ownerOnly === true && actor.isOwner === false) {
      throw new ForbiddenException(OWNER_REQUIRED_MESSAGE);
    }
    if (roles === undefined || roles.includes(actor.role) === true) {
      return true;
    }
    throw new ForbiddenException(ROLE_REQUIRED_MESSAGE);
  }
}
