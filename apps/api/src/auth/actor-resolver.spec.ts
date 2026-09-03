import type { IncomingMessage } from 'http';
import type { BetterAuthInstance } from './better-auth.factory';
import { CLIENT_IP_HEADER, createBetterAuth } from './better-auth.factory';
import { resolveWorkspaceConfig, WorkspaceConfig } from './workspace-config';
import { ActorResolver } from './actor-resolver';

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

  describe('resolveFromUpgrade', () => {
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
