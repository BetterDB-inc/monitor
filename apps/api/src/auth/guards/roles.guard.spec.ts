import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Actor } from '@betterdb/shared';
import { WorkspaceConfig } from '../workspace-config';
import { OwnerOnly, Roles } from './roles.decorator';
import { OWNER_REQUIRED_MESSAGE, ROLE_REQUIRED_MESSAGE, RolesGuard } from './roles.guard';

class Fixture {
  @Roles('admin')
  adminOnly(): void {}

  @OwnerOnly()
  ownerOnly(): void {}

  @Roles('admin', 'member')
  anyRole(): void {}

  @Roles()
  unconstrained(): void {}

  open(): void {}
}

const enabledConfig: WorkspaceConfig = {
  enabled: true,
  mode: 'self-hosted',
  publicUrl: null,
  basePath: '/auth',
  brokerUrl: 'https://betterdb.com',
  trustedOrigins: [],
};

function actorOf(role: 'admin' | 'member', isOwner: boolean): Actor {
  return { userId: 'u1', email: 'u@example.com', role, isOwner, via: 'session', tokenId: null };
}

function contextFor(actor: Actor | null, handler: keyof Fixture): ExecutionContext {
  return {
    getHandler: () => {
      return Fixture.prototype[handler];
    },
    getClass: () => {
      return Fixture;
    },
    switchToHttp: () => {
      return {
        getRequest: () => {
          return { actor, method: 'GET', url: '/x' };
        },
      };
    },
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector(), enabledConfig);

  it('allows routes without role metadata for any actor', () => {
    expect(guard.canActivate(contextFor(actorOf('member', false), 'open'))).toBe(true);
    expect(guard.canActivate(contextFor(null, 'open'))).toBe(true);
  });

  it('treats an empty @Roles() list as no constraint', () => {
    expect(guard.canActivate(contextFor(actorOf('member', false), 'unconstrained'))).toBe(true);
    expect(guard.canActivate(contextFor(null, 'unconstrained'))).toBe(true);
  });

  it('allows admins and owners on admin routes', () => {
    expect(guard.canActivate(contextFor(actorOf('admin', false), 'adminOnly'))).toBe(true);
    expect(guard.canActivate(contextFor(actorOf('admin', true), 'adminOnly'))).toBe(true);
  });

  it('rejects members on admin routes with 403', () => {
    expect(() => {
      guard.canActivate(contextFor(actorOf('member', false), 'adminOnly'));
    }).toThrow(new ForbiddenException(ROLE_REQUIRED_MESSAGE));
  });

  it('allows members on routes that list member', () => {
    expect(guard.canActivate(contextFor(actorOf('member', false), 'anyRole'))).toBe(true);
  });

  it('rejects non-owners on owner-only routes even when admin', () => {
    expect(() => {
      guard.canActivate(contextFor(actorOf('admin', false), 'ownerOnly'));
    }).toThrow(new ForbiddenException(OWNER_REQUIRED_MESSAGE));
    expect(guard.canActivate(contextFor(actorOf('admin', true), 'ownerOnly'))).toBe(true);
  });

  it('rejects a missing actor on a role-restricted route with 401', () => {
    expect(() => {
      guard.canActivate(contextFor(null, 'adminOnly'));
    }).toThrow(UnauthorizedException);
  });

  it('is a no-op when the workspace is disabled', () => {
    const disabled = new RolesGuard(new Reflector(), {
      ...enabledConfig,
      enabled: false,
      mode: 'disabled',
    });
    expect(disabled.canActivate(contextFor(null, 'ownerOnly'))).toBe(true);
  });
});
