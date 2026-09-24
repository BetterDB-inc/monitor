import type { ExecutionContext } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { CloudAuthGuardImpl } from './cloud-auth.guard';

const SECRET = 'cloud-session-secret';
const TOUCHED = ['CLOUD_MODE', 'SESSION_SECRET', 'DB_SCHEMA', 'DEMO_HOSTNAME'];

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

describe('CloudAuthGuardImpl', () => {
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

  it('populates request.actor from the session payload', () => {
    const token = jwt.sign(
      { userId: 'u1', email: 'o@example.com', role: 'owner', subdomain: 'acme', tenantId: 't1' },
      SECRET,
      { algorithm: 'HS256' },
    );
    const request: FakeRequest = {
      url: '/api/connections',
      headers: { cookie: `betterdb_session=${token}`, host: 'acme.betterdb.com' },
    };
    const { context, redirect } = contextFor(request);
    expect(new CloudAuthGuardImpl().canActivate(context)).toBe(true);
    expect(redirect).not.toHaveBeenCalled();
    expect(request.actor).toEqual({
      userId: 'u1',
      email: 'o@example.com',
      role: 'admin',
      isOwner: true,
      via: 'session',
      tokenId: null,
    });
    expect(request.cloudUser).toMatchObject({ userId: 'u1', role: 'owner' });
  });

  it('leaves request.actor null and redirects without a session', () => {
    const request: FakeRequest = {
      url: '/api/connections',
      headers: { host: 'acme.betterdb.com' },
    };
    const { context, redirect } = contextFor(request);
    expect(new CloudAuthGuardImpl().canActivate(context)).toBe(false);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(request.actor).toBeNull();
  });
});
