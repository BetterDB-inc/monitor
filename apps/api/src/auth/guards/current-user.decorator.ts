import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Actor } from '@betterdb/shared';
import type { RequestWithActor } from './actor.guard';

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const request = ctx.switchToHttp().getRequest<RequestWithActor>();
  if (request.actor === null || request.actor === undefined) {
    throw new UnauthorizedException('Sign in required');
  }
  return request.actor;
});
