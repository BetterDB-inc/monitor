import type { IncomingMessage } from 'http';
import * as jwt from 'jsonwebtoken';
import { CloudActorResolver } from './cloud-actor-resolver';

const SECRET = 'cloud-session-secret';
const TOUCHED = ['SESSION_SECRET', 'DB_SCHEMA', 'DEMO_HOSTNAME'];

function upgradeRequest(cookie: string | undefined, host: string): IncomingMessage {
  return { headers: { cookie, host } } as unknown as IncomingMessage;
}

function sessionCookie(
  subdomain: string,
  role: string,
  secret: string = SECRET,
  claims: jwt.JwtPayload = {},
): string {
  const token = jwt.sign(
    { userId: 'u1', email: 'o@example.com', role, subdomain, ...claims },
    secret,
    { algorithm: 'HS256' },
  );
  return `other=1; betterdb_session=${token}`;
}

describe('CloudActorResolver', () => {
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    process.env.SESSION_SECRET = SECRET;
    process.env.DB_SCHEMA = 'tenant_acme_co';
    delete process.env.DEMO_HOSTNAME;
  });

  afterEach(() => {
    for (const key of TOUCHED) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('requires a session on cloud upgrades without making members read-only', () => {
    const resolver = new CloudActorResolver();
    expect(resolver.isEnabled()).toBe(true);
    expect(resolver.isReady()).toBe(true);
    expect(resolver.enforcesMemberReadOnly()).toBe(false);
  });

  it('resolves the actor from the cloud session cookie on an upgrade request', async () => {
    const actor = await new CloudActorResolver().resolveFromUpgrade(
      upgradeRequest(sessionCookie('acme-co', 'member'), 'acme-co.betterdb.com'),
    );
    expect(actor).toEqual({
      userId: 'u1',
      email: 'o@example.com',
      role: 'member',
      isOwner: false,
      via: 'session',
      tokenId: null,
    });
  });

  it('returns null without a session cookie', async () => {
    const actor = await new CloudActorResolver().resolveFromUpgrade(
      upgradeRequest(undefined, 'acme-co.betterdb.com'),
    );
    expect(actor).toBeNull();
  });

  it('returns null for a session signed with another secret', async () => {
    const actor = await new CloudActorResolver().resolveFromUpgrade(
      upgradeRequest(sessionCookie('acme-co', 'owner', 'wrong-secret'), 'acme-co.betterdb.com'),
    );
    expect(actor).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const expired = { exp: Math.floor(Date.now() / 1000) - 60 };
    const actor = await new CloudActorResolver().resolveFromUpgrade(
      upgradeRequest(sessionCookie('acme-co', 'owner', SECRET, expired), 'acme-co.betterdb.com'),
    );
    expect(actor).toBeNull();
  });

  it('returns null for a session from another tenant', async () => {
    const actor = await new CloudActorResolver().resolveFromUpgrade(
      upgradeRequest(sessionCookie('other', 'owner'), 'other.betterdb.com'),
    );
    expect(actor).toBeNull();
  });

  it('accepts a session from another tenant on the demo host', async () => {
    process.env.DEMO_HOSTNAME = 'demo.betterdb.com';
    const actor = await new CloudActorResolver().resolveFromUpgrade(
      upgradeRequest(sessionCookie('other', 'owner'), 'demo.betterdb.com'),
    );
    expect(actor).toEqual(expect.objectContaining({ userId: 'u1', role: 'admin', isOwner: true }));
  });
});
