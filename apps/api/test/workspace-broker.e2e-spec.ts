import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { generateKeyPairSync } from 'crypto';
import { rmSync } from 'fs';
import * as jwt from 'jsonwebtoken';
import { tmpdir } from 'os';
import { join } from 'path';

const TRUSTED_ORIGIN = 'http://localhost:5173';
const BROKER_KEY_ID = 'brk-e2e';
const MEMBER_EMAIL = 'member@example.com';
const STRANGER_EMAIL = 'stranger@example.com';
const OWNER_EMAIL = 'owner@example.com';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TOUCHED = [
  'WORKSPACE_DISABLED',
  'NODE_ENV',
  'BETTERDB_DATA_DIR',
  'AUTH_PUBLIC_URL',
  'AUTH_SECRET',
  'STORAGE_TYPE',
  'STORAGE_SQLITE_FILEPATH',
  'AUTH_BROKER_PUBLIC_KEY',
  'AUTH_BROKER_KEY_ID',
];

interface WorkspaceStatus {
  broker: boolean;
}

interface WorkspaceMe {
  userId: string;
  email: string;
  role: string;
  isOwner: boolean;
}

interface ActivityItem {
  action: string;
  details: { method?: string; provider?: string };
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const cookies = ([] as string[]).concat(setCookie ?? []).join('\n');
  const [first] = cookies.split(';');
  return first;
}

let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

describe('Workspace broker sign-in (E2E)', () => {
  let app: NestFastifyApplication;
  const previous = new Map<string, string | undefined>();
  const sqlitePath = join(tmpdir(), `workspace-broker-${Date.now()}.db`);

  function tokenFor(
    state: string,
    audience: string,
    overrides: Record<string, unknown> = {},
  ): string {
    return jwt.sign(
      {
        typ: 'self-hosted-broker',
        email: OWNER_EMAIL,
        name: 'Owner',
        avatarUrl: null,
        provider: 'github',
        providerId: 'gh-owner',
        state,
        ...overrides,
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: BROKER_KEY_ID,
        issuer: 'betterdb-entitlement',
        audience,
        expiresIn: '5m',
      },
    );
  }

  async function start(query: string): Promise<{ state: string; audience: string }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/broker/start${query}`,
      remoteAddress: nextIp(),
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    const redirect = new URL(String(location.searchParams.get('redirect')));
    return { state: String(location.searchParams.get('state')), audience: redirect.origin };
  }

  async function callback(
    token: string,
  ): Promise<{ status: number; location: string; cookie: string }> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/auth/broker/callback?token=${encodeURIComponent(token)}`,
      remoteAddress: nextIp(),
    });
    return {
      status: response.statusCode,
      location: String(response.headers.location),
      cookie: extractSessionCookie(response.headers['set-cookie']),
    };
  }

  async function me(cookie: string): Promise<WorkspaceMe> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as WorkspaceMe;
  }

  beforeAll(async () => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.AUTH_SECRET;
    delete process.env.AUTH_PUBLIC_URL;
    process.env.NODE_ENV = 'test';
    process.env.BETTERDB_DATA_DIR = '';
    process.env.STORAGE_TYPE = 'sqlite';
    process.env.STORAGE_SQLITE_FILEPATH = sqlitePath;
    process.env.AUTH_BROKER_PUBLIC_KEY = publicKey;
    process.env.AUTH_BROKER_KEY_ID = BROKER_KEY_ID;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api', {
      exclude: [
        { path: 'ingest/*splat', method: RequestMethod.ALL },
        { path: 'v1/traces', method: RequestMethod.POST },
      ],
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    rmSync(sqlitePath, { force: true });
    rmSync(`${sqlitePath}-wal`, { force: true });
    rmSync(`${sqlitePath}-shm`, { force: true });
    for (const key of TOUCHED) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('reports broker sign-in as available', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/workspace' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as WorkspaceStatus).broker).toBe(true);
  });

  it('registers the first broker sign-in as the workspace owner', async () => {
    const { state, audience } = await start('?provider=github');
    const result = await callback(tokenFor(state, audience));
    expect(result.status).toBe(302);
    expect(result.cookie).toContain('session_token=');

    const owner = await me(result.cookie);
    expect(owner.isOwner).toBe(true);
    expect(owner.email).toBe(OWNER_EMAIL);
  });

  it('admits an invited member with the invited role', async () => {
    const { state: ownerState, audience } = await start('?provider=github');
    const ownerCallback = await callback(tokenFor(ownerState, audience));
    const ownerCookie = ownerCallback.cookie;

    const invite = await app.inject({
      method: 'POST',
      url: '/api/workspace/invite',
      headers: {
        'content-type': 'application/json',
        origin: TRUSTED_ORIGIN,
        cookie: ownerCookie,
      },
      payload: { email: MEMBER_EMAIL, role: 'member' },
    });
    expect(invite.statusCode).toBe(201);
    const inviteToken = (invite.json() as { url: string }).url.split('/invite/')[1];

    const { state: memberState } = await start(`?invite=${encodeURIComponent(inviteToken)}`);
    const memberCallback = await callback(
      tokenFor(memberState, audience, {
        email: MEMBER_EMAIL,
        name: 'Member',
        providerId: 'gh-member',
      }),
    );
    expect(memberCallback.status).toBe(302);
    expect(memberCallback.cookie).toContain('session_token=');

    const member = await me(memberCallback.cookie);
    expect(member.role).toBe('member');
    expect(member.isOwner).toBe(false);
  });

  it('refuses a stranger without a pending invitation', async () => {
    const { state, audience } = await start('');
    const result = await callback(
      tokenFor(state, audience, { email: STRANGER_EMAIL, providerId: 'gh-stranger' }),
    );
    expect(result.status).toBe(302);
    expect(result.location).toBe(`${TRUSTED_ORIGIN}/login?error=not_invited`);
    expect(result.cookie).toBe('');
  });

  it('lists the broker logins with their provider in the activity feed', async () => {
    const { state, audience } = await start('?provider=github');
    const ownerCallback = await callback(tokenFor(state, audience));

    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/activity',
      headers: { cookie: ownerCallback.cookie },
    });
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { items: ActivityItem[] }).items;
    const brokerLogins = items.filter((item) => {
      return item.action === 'auth.login' && item.details.provider !== undefined;
    });
    expect(brokerLogins).toHaveLength(4);
    const methods = brokerLogins.map((item) => {
      return item.details.method;
    });
    expect([...methods].sort()).toEqual(['github', 'github', 'invite', 'register']);
    for (const item of brokerLogins) {
      expect(item.details.provider).toBe('github');
    }
  });
});
