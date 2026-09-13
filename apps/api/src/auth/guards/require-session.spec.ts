import { ForbiddenException } from '@nestjs/common';
import type { Actor } from '@betterdb/shared';
import { requireSession, SESSION_REQUIRED_MESSAGE } from './require-session';

function actor(via: Actor['via']): Actor {
  return {
    userId: 'u1',
    email: 'a@example.com',
    role: 'admin',
    isOwner: true,
    via,
    tokenId: via === 'token' ? 't1' : null,
  };
}

describe('requireSession', () => {
  it('accepts a session actor', () => {
    expect(() => {
      requireSession(actor('session'));
    }).not.toThrow();
  });

  it('rejects token and cli actors', () => {
    expect(() => {
      requireSession(actor('token'));
    }).toThrow(new ForbiddenException(SESSION_REQUIRED_MESSAGE));
    expect(() => {
      requireSession(actor('cli'));
    }).toThrow(ForbiddenException);
  });
});
