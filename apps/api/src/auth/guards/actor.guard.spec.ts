import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Actor } from '@betterdb/shared';
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
  actor?: Actor | null;
}

function contextFor(request: FakeRequest): ExecutionContext {
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
      '/system/demo',
      '/health',
      '/api/health',
      '/docs',
      '/telemetry/event',
      '/mcp/tools',
      '/prometheus',
      '/ingest/e',
      '/v1/traces',
      '/version',
    ]) {
      expect(isPublicPath(path)).toBe(true);
    }
  });

  it('protects everything else', () => {
    for (const path of ['/connections', '/api/connections', '/workspace/me', '/settings', '/']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});

describe('ActorGuard', () => {
  const config: WorkspaceConfig = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN });
  let auth: BetterAuthInstance;

  beforeAll(async () => {
    auth = await createBetterAuth({ handle: { kind: 'memory' }, secret: SECRET, config });
  });

  it('allows everything with a null actor when the workspace is disabled', async () => {
    const guard = new ActorGuard(resolveWorkspaceConfig({ WORKSPACE_DISABLED: 'true' }), null);
    const request: FakeRequest = { url: '/connections', headers: {} };
    expect(await guard.canActivate(contextFor(request))).toBe(true);
    expect(request.actor).toBeNull();
  });

  it('allows public paths without a session', async () => {
    const guard = new ActorGuard(config, auth);
    const request: FakeRequest = { url: '/auth/sign-in/email?x=1', headers: {} };
    expect(await guard.canActivate(contextFor(request))).toBe(true);
    expect(request.actor).toBeNull();
  });

  it('rejects protected paths without a session with 401', async () => {
    const guard = new ActorGuard(config, auth);
    await expect(
      guard.canActivate(contextFor({ url: '/connections', headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('resolves the actor from a session cookie', async () => {
    const guard = new ActorGuard(config, auth);
    const cookie = await signedInCookie(auth);
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
});
