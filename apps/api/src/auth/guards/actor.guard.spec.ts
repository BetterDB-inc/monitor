import {
  ExecutionContext,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Actor } from '@betterdb/shared';
import type { PersonalTokenService } from '../../workspace/personal-token.service';
import { ActorResolver } from '../actor-resolver';
import type { BetterAuthInstance } from '../better-auth.factory';
import { CLIENT_IP_HEADER, createBetterAuth } from '../better-auth.factory';
import { resolveWorkspaceConfig, WorkspaceConfig } from '../workspace-config';
import { ActorGuard } from './actor.guard';
import { isActorOptionalPath, isPublicPath } from './public-paths';

const SECRET = 's'.repeat(40);
const ORIGIN = 'http://localhost:3001';

interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  method?: string;
  ip?: string;
  actor?: Actor | null;
}

interface FakeReply {
  header: jest.Mock;
}

function fakeReply(): FakeReply {
  return { header: jest.fn() };
}

function contextFor(request: FakeRequest, reply: FakeReply = fakeReply()): ExecutionContext {
  if (request.method === undefined) {
    request.method = 'GET';
  }
  return {
    switchToHttp: () => {
      return {
        getRequest: () => {
          return request;
        },
        getResponse: () => {
          return reply;
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
      '/v1/external/metrics',
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

describe('isActorOptionalPath', () => {
  it('matches the mcp surface with or without the /api prefix', () => {
    for (const path of [
      '/mcp',
      '/mcp/instances',
      '/api/mcp/instances',
      '/api/mcp/instance/local/memory/agent/recall?limit=5',
    ]) {
      expect(isActorOptionalPath(path)).toBe(true);
    }
  });

  it('does not match other public paths', () => {
    for (const path of [
      '/ingest/e',
      '/api/ingest/x',
      '/v1/traces',
      '/api/v1/traces',
      '/v1/external/metrics',
      '/api/v1/external/metrics',
      '/auth/sign-in/email',
      '/api/auth/get-session',
      '/prometheus',
      '/telemetry/event',
      '/mcp-internal',
      '/api/mcpx/tools',
    ]) {
      expect(isActorOptionalPath(path)).toBe(false);
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
    const guard = new ActorGuard(new ActorResolver(config, auth));
    await expect(
      guard.canActivate(
        contextFor({ url: '/api/mcp/cache-proposals/p1/approve', headers: {}, method: 'POST' }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('still serves mcp reads without a session', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
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

  it('forwards a renewed session cookie to the reply', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    const getSession = jest.spyOn(auth.api, 'getSession');
    getSession.mockResolvedValueOnce({
      headers: new Headers([['set-cookie', 'better-auth.session_token=x; Max-Age=604800']]),
      response: { user: { id: 'u1', email: 'owner@example.com', role: 'admin', isOwner: true } },
    } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>);
    const reply = fakeReply();
    const request: FakeRequest = { url: '/api/connections', headers: { cookie } };
    await guard.canActivate(contextFor(request, reply));
    expect(getSession.mock.calls[0][0]).toEqual(expect.objectContaining({ returnHeaders: true }));
    expect(reply.header).toHaveBeenCalledWith('set-cookie', [
      'better-auth.session_token=x; Max-Age=604800',
    ]);
    getSession.mockRestore();
  });

  it('leaves the reply untouched when the session carries no set-cookie', async () => {
    const guard = new ActorGuard(new ActorResolver(config, auth));
    const getSession = jest.spyOn(auth.api, 'getSession');
    getSession.mockResolvedValueOnce({
      headers: new Headers(),
      response: { user: { id: 'u1', email: 'owner@example.com', role: 'admin', isOwner: true } },
    } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>);
    const reply = fakeReply();
    const request: FakeRequest = { url: '/api/connections', headers: { cookie } };
    await guard.canActivate(contextFor(request, reply));
    expect(reply.header).not.toHaveBeenCalled();
    getSession.mockRestore();
  });
});

describe('ActorGuard bearer tokens', () => {
  const config: WorkspaceConfig = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN });
  const tokenActor: Actor = {
    userId: 'u-token',
    email: 'bot@example.com',
    role: 'admin',
    isOwner: false,
    via: 'token',
    tokenId: 't-1',
  };
  let auth: BetterAuthInstance;

  beforeAll(async () => {
    auth = await createBetterAuth({ handle: { kind: 'memory' }, secret: SECRET, config });
  });

  function guardWith(resolveActor: jest.Mock): ActorGuard {
    const tokens = { resolveActor } as unknown as PersonalTokenService;
    return new ActorGuard(new ActorResolver(config, auth, tokens));
  }

  function bearerRequest(url: string, method = 'GET'): FakeRequest {
    return { url, method, headers: { authorization: 'Bearer bdb_mcp_x' }, ip: '10.0.0.1' };
  }

  it('attaches the token owner on a protected path', async () => {
    const request = bearerRequest('/workspace/me');
    const guard = guardWith(jest.fn().mockResolvedValue(tokenActor));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toEqual(tokenActor);
  });

  it('rejects an unknown bearer token on a protected path', async () => {
    const request = bearerRequest('/workspace/me', 'POST');
    const guard = guardWith(jest.fn().mockResolvedValue(null));
    await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('attaches the token owner on a public MCP read', async () => {
    const request = bearerRequest('/api/mcp/instances');
    const guard = guardWith(jest.fn().mockResolvedValue(tokenActor));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toEqual(tokenActor);
  });

  it('lets a public MCP read through anonymously when the token is rejected', async () => {
    const request = bearerRequest('/api/mcp/instances');
    const guard = guardWith(jest.fn().mockResolvedValue(null));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toBeNull();
  });

  it('lets a public MCP read through anonymously when the token lookup fails', async () => {
    const request = bearerRequest('/api/mcp/instances');
    const guard = guardWith(jest.fn().mockRejectedValue(new Error('storage down')));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toBeNull();
  });

  it('skips resolution on a public path without a cookie or Authorization header', async () => {
    const resolveActor = jest.fn();
    const request: FakeRequest = { url: '/api/mcp/instances', headers: {}, ip: '10.0.0.1' };
    await expect(guardWith(resolveActor).canActivate(contextFor(request))).resolves.toBe(true);
    expect(resolveActor).not.toHaveBeenCalled();
    expect(request.actor).toBeNull();
  });

  function stubResolver(resolveFromHeaders: jest.Mock, resolveBearer: jest.Mock): ActorResolver {
    return {
      isEnabled: () => {
        return true;
      },
      isReady: () => {
        return true;
      },
      resolveFromHeaders,
      resolveBearer,
    } as unknown as ActorResolver;
  }

  const sessionActor: Actor = {
    userId: 'u-session',
    email: 'person@example.com',
    role: 'member',
    isOwner: false,
    via: 'session',
    tokenId: null,
  };

  it('resolves a public call with both credentials session-first', async () => {
    const resolveFromHeaders = jest.fn().mockResolvedValue(sessionActor);
    const resolveBearer = jest.fn();
    const request: FakeRequest = {
      url: '/api/mcp/instances',
      method: 'GET',
      headers: { cookie: 'better-auth.session_token=abc', authorization: 'Bearer bdb_mcp_x' },
      ip: '10.0.0.1',
    };
    const guard = new ActorGuard(stubResolver(resolveFromHeaders, resolveBearer));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toEqual(sessionActor);
    expect(resolveFromHeaders).toHaveBeenCalledWith(request.headers, '10.0.0.1');
    expect(resolveBearer).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/ingest/x', 'POST'],
    ['/v1/traces', 'POST'],
    ['/v1/external/metrics', 'POST'],
    ['/auth/sign-in/email', 'POST'],
  ])('skips actor resolution on non-mcp public path %s', async (url, method) => {
    const resolveFromHeaders = jest.fn().mockResolvedValue(sessionActor);
    const resolveBearer = jest.fn().mockResolvedValue(tokenActor);
    const request: FakeRequest = {
      url,
      method,
      headers: { cookie: 'better-auth.session_token=abc', authorization: 'Bearer bdb_mcp_x' },
      ip: '10.0.0.1',
    };
    const guard = new ActorGuard(stubResolver(resolveFromHeaders, resolveBearer));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toBeNull();
    expect(resolveFromHeaders).not.toHaveBeenCalled();
    expect(resolveBearer).not.toHaveBeenCalled();
  });

  it('resolves a bearer token on an mcp public path', async () => {
    const resolveFromHeaders = jest.fn().mockResolvedValue(tokenActor);
    const request: FakeRequest = {
      url: '/api/mcp/instance/local/memory/agent/recall',
      method: 'POST',
      headers: { authorization: 'Bearer bdb_mcp_x' },
      ip: '10.0.0.1',
    };
    const guard = new ActorGuard(stubResolver(resolveFromHeaders, jest.fn()));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(resolveFromHeaders).toHaveBeenCalledWith(request.headers, '10.0.0.1');
    expect(request.actor).toEqual(tokenActor);
  });

  it('attaches the session actor to a session-only public call', async () => {
    const resolveFromHeaders = jest.fn().mockResolvedValue(sessionActor);
    const request: FakeRequest = {
      url: '/api/mcp/instances',
      method: 'GET',
      headers: { cookie: 'better-auth.session_token=abc' },
      ip: '10.0.0.1',
    };
    const guard = new ActorGuard(stubResolver(resolveFromHeaders, jest.fn()));
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.actor).toEqual(sessionActor);
  });
});
