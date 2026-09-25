import { ForbiddenException } from '@nestjs/common';
import type { Actor } from '@betterdb/shared';

export const SESSION_REQUIRED_MESSAGE = 'This action requires a signed-in session';

export function requireSession(actor: Actor): void {
  if (actor.via !== 'session') {
    throw new ForbiddenException(SESSION_REQUIRED_MESSAGE);
  }
}
