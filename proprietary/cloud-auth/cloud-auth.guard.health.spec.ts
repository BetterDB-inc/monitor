import type { ExecutionContext } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { CloudAuthGuardImpl } from './cloud-auth.guard';

const SECRET = 'cloud-session-secret';
const TOUCHED = ['CLOUD_MODE', 'SESSION_SECRET', 'DB_SCHEMA', 'DEMO_HOSTNAME'];
const HOST = 'acme.betterdb.com';
const PAYLOAD = {
  userId: 'u1',
  email: 'o@example.com',
  role: 'owner',
  subdomain: 'acme',
  tenantId: 't1',
};

interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  actor?: unknown;
  cloudUser?: unknown;
}

function contextFor(request: FakeRequest): { context: ExecutionContext; redirect: jest.Mock } {
  const redirect = jest.fn();
  const context = {
    switchToHttp: () => {
      return {
        getRequest: () => {
          return request;
        },
        getResponse: () => {
          return { redirect };
        },
      };
    },
  } as unknown as ExecutionContext;
  return { context, redirect };
}

function sessionCookie(token: string): string {
  return `betterdb_session=${token}`;
}

describe('CloudAuthGuardImpl on health paths', () => {
  const previous = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    process.env.CLOUD_MODE = 'true';
    process.env.SESSION_SECRET = SECRET;
    process.env.DB_SCHEMA = 'tenant_acme';
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

  it.each(['/api/health', '/api/health/detailed', '/health', '/health/detailed?x=1'])(
    'lets an anonymous probe through without an actor (%s)',
    (url) => {
      const request: FakeRequest = { url, headers: { host: HOST } };
      const { context, redirect } = contextFor(request);
      expect(new CloudAuthGuardImpl().canActivate(context)).toBe(true);
      expect(redirect).not.toHaveBeenCalled();
      expect(request.actor).toBeNull();
      expect(request.cloudUser).toBeUndefined();
    },
  );

  it.each(['/api/health', '/api/health/detailed'])(
    'attaches the actor when a valid session is sent (%s)',
    (url) => {
      const token = jwt.sign(PAYLOAD, SECRET, { algorithm: 'HS256' });
      const request: FakeRequest = { url, headers: { cookie: sessionCookie(token), host: HOST } };
      const { context, redirect } = contextFor(request);
      expect(new CloudAuthGuardImpl().canActivate(context)).toBe(true);
      expect(redirect).not.toHaveBeenCalled();
      expect(request.actor).toMatchObject({ userId: 'u1', via: 'session' });
      expect(request.cloudUser).toMatchObject({ userId: 'u1', role: 'owner' });
    },
  );

  it.each([
    ['expired', jwt.sign({ ...PAYLOAD, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET)],
    ['wrongly signed', jwt.sign(PAYLOAD, 'not-the-secret', { algorithm: 'HS256' })],
    ['for another tenant', jwt.sign({ ...PAYLOAD, subdomain: 'other' }, SECRET)],
    ['malformed', 'not-a-jwt'],
  ])('still lets a probe through with an %s session, without an actor', (_label, token) => {
    const request: FakeRequest = {
      url: '/api/health/detailed',
      headers: { cookie: sessionCookie(token), host: HOST },
    };
    const { context, redirect } = contextFor(request);
    expect(new CloudAuthGuardImpl().canActivate(context)).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
    expect(request.actor).toBeNull();
    expect(request.cloudUser).toBeUndefined();
  });

  it.each(['/healthXYZ', '/api/healthcheck-admin', '/api/healthz'])(
    'does not treat a path that only shares the health prefix as health (%s)',
    (url) => {
      const request: FakeRequest = { url, headers: { host: HOST } };
      const { context, redirect } = contextFor(request);
      expect(new CloudAuthGuardImpl().canActivate(context)).toBe(false);
      expect(redirect).toHaveBeenCalledTimes(1);
      expect(request.actor).toBeNull();
    },
  );
});
