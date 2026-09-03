import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Actor } from '@betterdb/shared';
import { WorkspaceConfig } from '../workspace-config';
import { MutationGuard, READ_ONLY_MESSAGE } from './mutation.guard';
import { AllowMembers } from './roles.decorator';

class Fixture {
  @AllowMembers()
  search(): void {}

  write(): void {}
}

const enabledConfig: WorkspaceConfig = {
  enabled: true,
  mode: 'self-hosted',
  publicUrl: null,
  basePath: '/auth',
  brokerUrl: 'https://betterdb.com',
  trustedOrigins: [],
};

const admin: Actor = {
  userId: 'a',
  email: 'a@x',
  role: 'admin',
  isOwner: true,
  via: 'session',
  tokenId: null,
};
const member: Actor = {
  userId: 'm',
  email: 'm@x',
  role: 'member',
  isOwner: false,
  via: 'session',
  tokenId: null,
};

function contextFor(
  actor: Actor | null,
  method: string,
  url: string,
  handler: keyof Fixture = 'write',
): ExecutionContext {
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
          return { actor, method, url };
        },
      };
    },
  } as unknown as ExecutionContext;
}

describe('MutationGuard', () => {
  const guard = new MutationGuard(new Reflector(), enabledConfig);

  it('allows safe methods for everyone', () => {
    expect(guard.canActivate(contextFor(member, 'GET', '/connections'))).toBe(true);
    expect(guard.canActivate(contextFor(member, 'HEAD', '/connections'))).toBe(true);
    expect(guard.canActivate(contextFor(member, 'OPTIONS', '/connections'))).toBe(true);
  });

  it('allows admins to mutate', () => {
    expect(guard.canActivate(contextFor(admin, 'POST', '/connections'))).toBe(true);
    expect(guard.canActivate(contextFor(admin, 'DELETE', '/api/connections/1'))).toBe(true);
  });

  it('rejects members on mutating methods with 403 and the read-only message', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => {
        guard.canActivate(contextFor(member, method, '/api/settings?x=1'));
      }).toThrow(new ForbiddenException(READ_ONLY_MESSAGE));
    }
  });

  it('exempts public paths', () => {
    expect(guard.canActivate(contextFor(member, 'POST', '/auth/sign-out'))).toBe(true);
    expect(guard.canActivate(contextFor(member, 'POST', '/api/auth/sign-out'))).toBe(true);
    expect(guard.canActivate(contextFor(null, 'POST', '/api/telemetry/event'))).toBe(true);
  });

  it('does not exempt writes to /workspace/me for members', () => {
    expect(() => {
      guard.canActivate(contextFor(member, 'PATCH', '/api/workspace/me?tab=1'));
    }).toThrow(new ForbiddenException(READ_ONLY_MESSAGE));
  });

  it('exempts routes marked @AllowMembers()', () => {
    expect(
      guard.canActivate(contextFor(member, 'POST', '/vector-search/indexes/i/search', 'search')),
    ).toBe(true);
  });

  it('fails closed when a protected mutation has no actor', () => {
    expect(() => {
      guard.canActivate(contextFor(null, 'POST', '/connections'));
    }).toThrow(UnauthorizedException);
  });

  it('is a no-op when the workspace is disabled', () => {
    const disabled = new MutationGuard(new Reflector(), {
      ...enabledConfig,
      enabled: false,
      mode: 'disabled',
    });
    expect(disabled.canActivate(contextFor(null, 'DELETE', '/connections/1'))).toBe(true);
  });
});
