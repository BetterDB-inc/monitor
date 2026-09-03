import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Actor } from '@betterdb/shared';
import { ActorResolver } from '../actor-resolver';
import type { BetterAuthInstance } from '../better-auth.factory';
import { CLIENT_IP_HEADER, createBetterAuth } from '../better-auth.factory';
import { resolveWorkspaceConfig, WorkspaceConfig } from '../workspace-config';
import { ActorGuard } from './actor.guard';
import { isPublicPath } from './public-paths';

const SECRET = 's'.repeat(40);
const ORIGIN = 'http://localhost:3001';

interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  method?: string;
  ip?: string;
  actor?: Actor | null;
}

function contextFor(request: FakeRequest): ExecutionContext {
  if (request.method === undefined) {
    request.method = 'GET';
  }
  return {
    switchToHttp: () => {
      return {
        getRequest: () => {
          return request;
        },
      };
    },
  } as unknown as ExecutionContext;
}

async function signedInCookie(auth: BetterAuthInstance): Promise<string> {
  const response = await auth.handler(
    new Request(`${ORIGIN}/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        [CLIENT_IP_HEADER]: '10.1.8.1',
      },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery',
        name: 'O',
      }),
    }),
  );
  return response.headers.getSetCookie()[0].split(';')[0];
}

describe('isPublicPath', () => {
  it('lets auth, invite, status, health, docs, telemetry, mcp and prometheus through', () => {
    for (const path of [
      '/auth/sign-in/email',
      '/api/auth/get-session',
      '/invite/abc',
      '/system/workspace',
      '/api/system/workspace',
      '/health',
      '/api/health',
      '/docs',
      '/telemetry/event',
      '/mcp/tools',
      '/prometheus',
      '/ingest/e',
      '/v1/traces',
      '/version',
      '/health/live',
    ]) {
      expect(isPublicPath(path, 'GET')).toBe(true);
    }
  });

  it('keeps reads and the non-mutating writes of the mcp surface public', () => {
    expect(isPublicPath('/mcp/instances', 'GET')).toBe(true);
    expect(isPublicPath('/api/mcp/instance/local/cache-proposals/pending', 'GET')).toBe(true);
    expect(isPublicPath('/mcp/telemetry', 'POST')).toBe(true);
    expect(isPublicPath('/api/mcp/instance/local/memory/agent/recall', 'POST')).toBe(true);
  });

  it('requires a session for mcp writes that apply changes', () => {
    for (const path of [
      '/mcp/instance/local/cache-proposals/invalidate',
      '/api/mcp/cache-proposals/p1/approve',
      '/mcp/cache-proposals/p1/edit-and-approve',
      '/mcp/instance/local/memory-proposals/forget',
      '/api/mcp/memory-proposals/p1/approve',
      '/mcp/memory-proposals/p1/reject',
    ]) {
      expect(isPublicPath(path, 'POST')).toBe(false);
    }
    expect(isPublicPath('/mcp/instances', 'DELETE')).toBe(false);
  });

  it('protects everything else', () => {
    for (const path of ['/connections', '/api/connections', '/workspace/me', '/settings', '/']) {
      expect(isPublicPath(path, 'GET')).toBe(false);
    }
  });

  it('keeps the rest of /system behind the guard', () => {
    for (const path of [
      '/system/connect-defaults',
      '/api/system/connect-defaults',
      '/system/demo',
      '/api/system/demo',
    ]) {
      expect(isPublicPath(path, 'GET')).toBe(false);
    }
  });

  it('does not treat a longer path sharing a prefix string as public', () => {
    for (const path of ['/healthz-private', '/docsite', '/prometheus-internal', '/versioning']) {
      expect(isPublicPath(path, 'GET')).toBe(false);
    }
  });
});

describe('ActorGuard', () => {
  const config: WorkspaceConfig = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN });
  let auth: BetterAuthInstance;
  let cookie: string;

  beforeAll(async () => {
    auth = await createBetterAuth({ handle: { kind: 'memory' }, secret: SECRET, config });
    cookie = await signedInCookie(auth);
  });

  it('allows everything with a null actor when the workspace is disabled', async () => {
    const guard = new ActorGuard(
      new ActorResolver(resolveWorkspaceConfig({ WORKSPACE_DISABLED: 'true' }), null),
    );
    const request: FakeRequest = { url: '/connections', headers: {} };
    expect(await guard.canActivate(contextFor(request))).toBe(true);
    expect(request.actor).toBeNull();
  });

  it('allows public paths without a session', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    const request: FakeRequest = { url: '/auth/sign-in/email?x=1', headers: {} };
    expect(await guard.canActivate(contextFor(request))).toBe(true);
    expect(request.actor).toBeNull();
  });

  it('rejects protected paths without a session with 401', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    await expect(
      guard.canActivate(contextFor({ url: '/connections', headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails closed when the workspace is enabled but no auth instance is wired', async () => {
    const guard = new ActorGuard(new ActorResolver(config, null));
    await expect(
      guard.canActivate(contextFor({ url: '/connections', headers: {} })),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    const publicRequest: FakeRequest = { url: '/auth/sign-in/email', headers: {} };
    expect(await guard.canActivate(contextFor(publicRequest))).toBe(true);
    expect(publicRequest.actor).toBeNull();
  });

  it('treats a malformed session cookie as signed out', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    const cookieName = cookie.split('=')[0];
    const request: FakeRequest = {
      url: '/connections',
      headers: { cookie: `${cookieName}=garbage.value` },
    };
    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.actor).toBeNull();
  });

  it('resolves the actor from a session cookie', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    const request: FakeRequest = { url: '/api/connections', headers: { cookie } };
    expect(await guard.canActivate(contextFor(request))).toBe(true);
    expect(request.actor).toEqual(
      expect.objectContaining({
        email: 'owner@example.com',
        role: 'admin',
        isOwner: true,
        via: 'session',
        tokenId: null,
      }),
    );
  });

  it('rejects /system/connect-defaults without a session', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    await expect(
      guard.canActivate(contextFor({ url: '/api/system/connect-defaults', headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('allows /system/workspace without a session', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    const request: FakeRequest = { url: '/api/system/workspace', headers: {} };
    expect(await guard.canActivate(contextFor(request))).toBe(true);
    expect(request.actor).toBeNull();
  });

  it('rejects an mcp proposal approval without a session', async () => {
    const guard = new ActorGuard(config, auth);
    await expect(
      guard.canActivate(
        contextFor({ url: '/api/mcp/cache-proposals/p1/approve', headers: {}, method: 'POST' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still serves mcp reads without a session', async () => {
    const guard = new ActorGuard(config, auth);
    const request: FakeRequest = { url: '/api/mcp/instances', headers: {}, method: 'GET' };
    expect(await guard.canActivate(contextFor(request))).toBe(true);
    expect(request.actor).toBeNull();
  });

  it('overrides a client-supplied ip header with the socket address', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    const getSession = jest.spyOn(auth.api, 'getSession');
    const request: FakeRequest = {
      url: '/api/connections',
      headers: { cookie, [CLIENT_IP_HEADER]: '203.0.113.9' },
      ip: '10.1.8.1',
    };
    await guard.canActivate(contextFor(request));
    const passed = getSession.mock.calls[0][0] as { headers: Headers };
    expect(passed.headers.get(CLIENT_IP_HEADER)).toBe('10.1.8.1');
    getSession.mockRestore();
  });
});
