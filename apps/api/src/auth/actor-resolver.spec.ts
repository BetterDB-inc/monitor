import type { IncomingMessage } from 'http';
import type { Actor } from '@betterdb/shared';
import type { PersonalTokenService } from '../workspace/personal-token.service';
import type { BetterAuthInstance } from './better-auth.factory';
import { CLIENT_IP_HEADER, createBetterAuth } from './better-auth.factory';
import { resolveWorkspaceConfig, WorkspaceConfig } from './workspace-config';
import { ActorResolver, bearerToken } from './actor-resolver';

function makeUpgradeRequest(cookie: string | undefined, remoteAddress: string): IncomingMessage {
  return {
    headers: { cookie },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

const SECRET = 's'.repeat(40);
const ORIGIN = 'http://localhost:3001';

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

describe('ActorResolver', () => {
  const config: WorkspaceConfig = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN });
  let auth: BetterAuthInstance;
  let cookie: string;

  beforeAll(async () => {
    auth = await createBetterAuth({ handle: { kind: 'memory' }, secret: SECRET, config });
    cookie = await signedInCookie(auth);
  });

  it('resolves the actor from a session cookie', async () => {
    const resolver = new ActorResolver(config, auth);
    const actor = await resolver.resolveFromHeaders({ cookie }, '10.0.0.1');
    expect(actor).toEqual({
      userId: expect.any(String),
      email: 'owner@example.com',
      role: 'admin',
      isOwner: true,
      via: 'session',
      tokenId: null,
    });
  });

  it('returns null when there is no cookie', async () => {
    const resolver = new ActorResolver(config, auth);
    const actor = await resolver.resolveFromHeaders({}, '10.0.0.1');
    expect(actor).toBeNull();
  });

  it('returns null for a malformed session cookie', async () => {
    const resolver = new ActorResolver(config, auth);
    const cookieName = cookie.split('=')[0];
    const actor = await resolver.resolveFromHeaders(
      { cookie: `${cookieName}=garbage.value` },
      '10.0.0.1',
    );
    expect(actor).toBeNull();
  });

  it('overrides a client-supplied ip header with the given client ip', async () => {
    const resolver = new ActorResolver(config, auth);
    const getSession = jest.spyOn(auth.api, 'getSession');
    await resolver.resolveFromHeaders({ cookie, [CLIENT_IP_HEADER]: '203.0.113.9' }, '10.1.8.1');
    const passed = getSession.mock.calls[0][0] as { headers: Headers };
    expect(passed.headers.get(CLIENT_IP_HEADER)).toBe('10.1.8.1');
    getSession.mockRestore();
  });

  it('follows config.enabled for isEnabled', () => {
    const enabledResolver = new ActorResolver(config, auth);
    expect(enabledResolver.isEnabled()).toBe(true);

    const disabledResolver = new ActorResolver(
      resolveWorkspaceConfig({ WORKSPACE_DISABLED: 'true' }),
      auth,
    );
    expect(disabledResolver.isEnabled()).toBe(false);
  });

  it('is not ready without an auth instance and resolves null without throwing', async () => {
    const resolver = new ActorResolver(config, null);
    expect(resolver.isReady()).toBe(false);
    await expect(resolver.resolveFromHeaders({ cookie }, '10.0.0.1')).resolves.toBeNull();
  });

  it('is ready when constructed with an auth instance', () => {
    const resolver = new ActorResolver(config, auth);
    expect(resolver.isReady()).toBe(true);
  });

  it('keeps workspace members read-only', () => {
    const resolver = new ActorResolver(config, auth);
    expect(resolver.enforcesMemberReadOnly()).toBe(true);
  });

  describe('resolveSessionFromHeaders', () => {
    it('returns the renewed session cookies alongside the actor', async () => {
      const resolver = new ActorResolver(config, auth);
      const getSession = jest.spyOn(auth.api, 'getSession');
      getSession.mockResolvedValueOnce({
        headers: new Headers([['set-cookie', 'better-auth.session_token=x; Max-Age=604800']]),
        response: { user: { id: 'u1', email: 'owner@example.com', role: 'admin', isOwner: true } },
      } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>);
      const resolution = await resolver.resolveSessionFromHeaders({ cookie }, '10.1.8.1');
      expect(getSession.mock.calls[0][0]).toEqual(
        expect.objectContaining({ returnHeaders: true, query: { disableCookieCache: true } }),
      );
      expect(resolution).toEqual({
        actor: expect.objectContaining({ userId: 'u1', role: 'admin', via: 'session' }),
        setCookies: ['better-auth.session_token=x; Max-Age=604800'],
      });
      getSession.mockRestore();
    });

    it('returns no actor and no cookies without an auth instance', async () => {
      const resolver = new ActorResolver(config, null);
      await expect(resolver.resolveSessionFromHeaders({ cookie }, '10.0.0.1')).resolves.toEqual({
        actor: null,
        setCookies: [],
      });
    });
  });

  describe('resolveFromUpgrade', () => {
    it('returns only the actor when the session renewal carries a set-cookie', async () => {
      const resolver = new ActorResolver(config, auth);
      const getSession = jest.spyOn(auth.api, 'getSession');
      getSession.mockResolvedValueOnce({
        headers: new Headers([['set-cookie', 'better-auth.session_token=x; Max-Age=604800']]),
        response: { user: { id: 'u1', email: 'owner@example.com', role: 'member' } },
      } as unknown as Awaited<ReturnType<typeof auth.api.getSession>>);
      const actor = await resolver.resolveFromUpgrade(makeUpgradeRequest(cookie, '10.1.8.1'));
      expect(actor).toEqual({
        userId: 'u1',
        email: 'owner@example.com',
        role: 'member',
        isOwner: false,
        via: 'session',
        tokenId: null,
      });
      getSession.mockRestore();
    });

    it('resolves the owner from an upgrade request carrying the cookie and remote address', async () => {
      const resolver = new ActorResolver(config, auth);
      const getSession = jest.spyOn(auth.api, 'getSession');
      const actor = await resolver.resolveFromUpgrade(makeUpgradeRequest(cookie, '10.1.8.1'));
      expect(actor).toEqual({
        userId: expect.any(String),
        email: 'owner@example.com',
        role: 'admin',
        isOwner: true,
        via: 'session',
        tokenId: null,
      });
      const passed = getSession.mock.calls[0][0] as { headers: Headers };
      expect(passed.headers.get(CLIENT_IP_HEADER)).toBe('10.1.8.1');
      getSession.mockRestore();
    });

    it('returns null without a cookie', async () => {
      const resolver = new ActorResolver(config, auth);
      const actor = await resolver.resolveFromUpgrade(makeUpgradeRequest(undefined, '10.0.0.1'));
      expect(actor).toBeNull();
    });

    it('returns null without throwing when getSession rejects', async () => {
      const resolver = new ActorResolver(config, auth);
      const getSession = jest
        .spyOn(auth.api, 'getSession')
        .mockRejectedValueOnce(new Error('boom'));
      const actor = await resolver.resolveFromUpgrade(makeUpgradeRequest(cookie, '10.1.8.1'));
      expect(actor).toBeNull();
      getSession.mockRestore();
    });

    it('returns null when constructed without an auth instance', async () => {
      const resolver = new ActorResolver(config, null);
      const actor = await resolver.resolveFromUpgrade(makeUpgradeRequest(cookie, '10.1.8.1'));
      expect(actor).toBeNull();
    });
  });
});

const TOKEN_ACTOR: Actor = {
  userId: 'u-token',
  email: 'bot@example.com',
  role: 'member',
  isOwner: false,
  via: 'token',
  tokenId: 't-1',
};

function tokenStub(actor: Actor | null): {
  service: PersonalTokenService;
  resolveActor: jest.Mock;
} {
  const resolveActor = jest.fn().mockResolvedValue(actor);
  return { service: { resolveActor } as unknown as PersonalTokenService, resolveActor };
}

describe('bearerToken', () => {
  it('reads the token from a Bearer header in any case', () => {
    expect(bearerToken({ authorization: 'Bearer abc' })).toBe('abc');
    expect(bearerToken({ authorization: 'bearer abc ' })).toBe('abc');
  });

  it('ignores missing, empty and non-bearer headers', () => {
    expect(bearerToken({})).toBeNull();
    expect(bearerToken({ authorization: 'Bearer ' })).toBeNull();
    expect(bearerToken({ authorization: 'Basic abc' })).toBeNull();
  });
});

describe('ActorResolver bearer tokens', () => {
  const config: WorkspaceConfig = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN });
  let auth: BetterAuthInstance;
  let cookie: string;

  beforeAll(async () => {
    auth = await createBetterAuth({ handle: { kind: 'memory' }, secret: SECRET, config });
    cookie = await signedInCookie(auth);
  });

  it('prefers the session cookie over a bearer token', async () => {
    const tokens = tokenStub(TOKEN_ACTOR);
    const resolver = new ActorResolver(config, auth, tokens.service);
    const actor = await resolver.resolveFromHeaders(
      { cookie, authorization: 'Bearer bdb_mcp_x' },
      '10.0.0.1',
    );
    expect(actor?.via).toBe('session');
    expect(tokens.resolveActor).not.toHaveBeenCalled();
  });

  it('falls back to the bearer token when there is no session', async () => {
    const tokens = tokenStub(TOKEN_ACTOR);
    const resolver = new ActorResolver(config, auth, tokens.service);
    const actor = await resolver.resolveFromHeaders(
      { authorization: 'Bearer bdb_mcp_x' },
      '10.0.0.1',
    );
    expect(actor).toEqual(TOKEN_ACTOR);
    expect(tokens.resolveActor).toHaveBeenCalledWith('bdb_mcp_x');
  });

  it('does not look up tokens for other authorization schemes', async () => {
    const tokens = tokenStub(TOKEN_ACTOR);
    const resolver = new ActorResolver(config, auth, tokens.service);
    expect(
      await resolver.resolveFromHeaders({ authorization: 'Basic abc' }, '10.0.0.1'),
    ).toBeNull();
    expect(tokens.resolveActor).not.toHaveBeenCalled();
  });

  it('resolves nothing from a bearer token without a token service', async () => {
    const resolver = new ActorResolver(config, auth);
    expect(await resolver.resolveBearer({ authorization: 'Bearer bdb_mcp_x' })).toBeNull();
  });

  it('keeps WebSocket upgrades session-only', async () => {
    const tokens = tokenStub(TOKEN_ACTOR);
    const resolver = new ActorResolver(config, auth, tokens.service);
    const bearerOnly = {
      headers: { authorization: 'Bearer bdb_mcp_x' },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as IncomingMessage;
    expect(await resolver.resolveFromUpgrade(bearerOnly)).toBeNull();
    expect(tokens.resolveActor).not.toHaveBeenCalled();

    const withSession = {
      headers: { cookie, authorization: 'Bearer bdb_mcp_x' },
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as IncomingMessage;
    const actor = await resolver.resolveFromUpgrade(withSession);
    expect(actor?.via).toBe('session');
  });
});
