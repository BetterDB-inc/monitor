import { Logger, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { generateKeyPairSync } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ACTIVITY_CONFIG } from '../../activity/activity-config';
import { ActivityService } from '../../activity/activity.service';
import { MemoryAdapter } from '../../storage/adapters/memory.adapter';
import { UsageTelemetryService } from '../../telemetry/usage-telemetry.service';
import { BrokerUserResolver } from '../../workspace/broker-user-resolver.service';
import { InvitationService } from '../../workspace/invitation.service';
import { MemberService } from '../../workspace/member.service';
import { WorkspaceController } from '../../workspace/workspace.controller';
import { ActorResolver } from '../actor-resolver';
import { BootstrapLock } from '../bootstrap-lock';
import { BetterAuthController } from '../better-auth.controller';
import { BETTER_AUTH, createBetterAuth } from '../better-auth.factory';
import { ActorGuard } from '../guards/actor.guard';
import { MutationGuard } from '../guards/mutation.guard';
import { RolesGuard } from '../guards/roles.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG, WorkspaceConfig } from '../workspace-config';
import { BROKER_NONCE_COOKIE } from './broker-nonce';
import { BrokerStateStore } from './broker-state.store';
import { BrokerController } from './broker.controller';

interface TelemetryStub {
  trackUserInvited: jest.Mock;
  trackInviteAccepted: jest.Mock;
  trackUserLogin: jest.Mock;
  trackWorkspaceFirstRegister: jest.Mock;
  trackMemberRemoved: jest.Mock;
}

interface BuiltApp {
  app: NestFastifyApplication;
  storage: MemoryAdapter;
  telemetry: TelemetryStub;
}

interface BuildOptions {
  throttled?: boolean;
}

interface CallbackResult {
  status: number;
  location: string;
  cookie: string;
  setCookies: string[];
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const { privateKey: foreignKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const BASE_ENV: NodeJS.ProcessEnv = {
  AUTH_PUBLIC_URL: 'http://localhost',
  AUTH_BROKER_URL: 'https://broker.example',
  AUTH_BROKER_PUBLIC_KEY: publicKey,
  AUTH_BROKER_KEY_ID: 'brk-test',
};

const SESSION_COOKIE = 'better-auth.session_token=';
const CLEARED_NONCE = `${BROKER_NONCE_COOKIE}=; Path=/auth; Max-Age=0; HttpOnly; SameSite=Lax`;

let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function allCookies(setCookie: unknown): string[] {
  if (Array.isArray(setCookie) === true) {
    return (setCookie as unknown[]).map((value) => {
      return String(value);
    });
  }
  if (setCookie === undefined) {
    return [];
  }
  return [String(setCookie)];
}

function cookieNamed(setCookie: unknown, prefix: string): string {
  const match = allCookies(setCookie).find((value) => {
    return value.startsWith(prefix);
  });
  if (match === undefined) {
    return '';
  }
  return match.split(';')[0];
}

function tokenFor(
  state: string,
  overrides: Record<string, unknown> = {},
  audience = 'http://localhost',
  key: string = privateKey,
): string {
  return jwt.sign(
    {
      typ: 'self-hosted-broker',
      email: 'owner@example.com',
      name: 'Owner',
      avatarUrl: null,
      provider: 'google',
      providerId: 'g-owner',
      state,
      ...overrides,
    },
    key,
    {
      algorithm: 'RS256',
      keyid: 'brk-test',
      issuer: 'betterdb-entitlement',
      audience,
      expiresIn: 300,
    },
  );
}

async function buildApp(config: WorkspaceConfig, options: BuildOptions = {}): Promise<BuiltApp> {
  const auth = await createBetterAuth({
    handle: { kind: 'memory' },
    secret: 's'.repeat(40),
    config,
  });
  const storage = new MemoryAdapter();
  await storage.initialize();
  const telemetry: TelemetryStub = {
    trackUserInvited: jest.fn(),
    trackInviteAccepted: jest.fn(),
    trackUserLogin: jest.fn(),
    trackWorkspaceFirstRegister: jest.fn(),
    trackMemberRemoved: jest.fn(),
  };
  const throttled = options.throttled === true;
  const moduleRef = await Test.createTestingModule({
    imports: throttled ? [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10_000 }])] : [],
    controllers: [BrokerController, BetterAuthController, WorkspaceController],
    providers: [
      { provide: BETTER_AUTH, useValue: auth },
      { provide: WORKSPACE_CONFIG, useValue: config },
      { provide: 'STORAGE_CLIENT', useValue: storage },
      { provide: UsageTelemetryService, useValue: telemetry },
      { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
      ActivityService,
      ActorResolver,
      BootstrapLock,
      MemberService,
      InvitationService,
      BrokerStateStore,
      BrokerUserResolver,
      ...(throttled ? [{ provide: APP_GUARD, useClass: ThrottlerGuard }] : []),
      { provide: APP_GUARD, useClass: ActorGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
      { provide: APP_GUARD, useClass: MutationGuard },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, storage, telemetry };
}

describe('BrokerController', () => {
  let built: BuiltApp;
  let app: NestFastifyApplication;
  let members: MemberService;
  let ownerToken = '';
  let ownerNonce = '';
  let ownerId = '';

  beforeAll(async () => {
    built = await buildApp(resolveWorkspaceConfig(BASE_ENV));
    app = built.app;
    members = app.get(MemberService);
  });

  afterAll(async () => {
    await app.close();
    await built.storage.close();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function start(
    query: string,
  ): Promise<{ state: string; location: URL; nonce: string; setCookies: string[] }> {
    const response = await app.inject({ method: 'GET', url: `/auth/broker/start${query}` });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    return {
      state: String(location.searchParams.get('state')),
      location,
      nonce: cookieNamed(response.headers['set-cookie'], `${BROKER_NONCE_COOKIE}=`),
      setCookies: allCookies(response.headers['set-cookie']),
    };
  }

  async function callback(token: string, nonce = ''): Promise<CallbackResult> {
    const response = await app.inject({
      method: 'GET',
      url: `/auth/broker/callback?token=${encodeURIComponent(token)}`,
      remoteAddress: nextIp(),
      headers: nonce === '' ? {} : { cookie: nonce },
    });
    return {
      status: response.statusCode,
      location: String(response.headers.location),
      cookie: cookieNamed(response.headers['set-cookie'], SESSION_COOKIE),
      setCookies: allCookies(response.headers['set-cookie']),
    };
  }

  async function latestLogin(): Promise<{ actorEmail: string; details: unknown }> {
    const page = await built.storage
      .getActivityRepository()
      .list({ limit: 50, action: 'auth.login' });
    const [latest] = page.items;
    return { actorEmail: latest.actorEmail, details: latest.details };
  }

  it('redirects start to the broker sign-in page with a callback, state and provider', async () => {
    const { state, location, nonce } = await start('?provider=google&next=%2Fsettings');
    expect(location.origin).toBe('https://broker.example');
    expect(location.pathname).toBe('/self-hosted/sign-in');
    expect(location.searchParams.get('redirect')).toBe('http://localhost/auth/broker/callback');
    expect(location.searchParams.get('provider')).toBe('google');
    expect(state).toHaveLength(43);
    ownerToken = tokenFor(state);
    ownerNonce = nonce;
  });

  it('binds start to the browser with a short-lived HttpOnly nonce cookie', async () => {
    const { setCookies, nonce } = await start('');
    expect(setCookies).toHaveLength(1);
    expect(nonce).toMatch(new RegExp(`^${BROKER_NONCE_COOKIE.replace('.', '\\.')}=[\\w-]{43}$`));
    expect(setCookies[0]).toBe(`${nonce}; Path=/auth; Max-Age=600; HttpOnly; SameSite=Lax`);
  });

  it('omits an unknown provider from the broker redirect', async () => {
    const { location } = await start('?provider=gitlab');
    expect(location.searchParams.has('provider')).toBe(false);
  });

  it('registers the first broker user as owner and signs them in', async () => {
    const result = await callback(ownerToken, ownerNonce);
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost/settings');
    expect(result.cookie).toContain(SESSION_COOKIE);
    expect(result.setCookies).toContain(CLEARED_NONCE);

    const me = await app.inject({
      method: 'GET',
      url: '/workspace/me',
      headers: { cookie: result.cookie },
    });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { userId: string; isOwner: boolean; email: string };
    expect(body.isOwner).toBe(true);
    expect(body.email).toBe('owner@example.com');
    ownerId = body.userId;

    expect(await latestLogin()).toEqual({
      actorEmail: 'owner@example.com',
      details: { method: 'register', provider: 'google' },
    });
    expect(built.telemetry.trackWorkspaceFirstRegister).toHaveBeenCalledWith({
      method: 'broker',
    });
  });

  it('rejects a replayed token as expired', async () => {
    const result = await callback(ownerToken, ownerNonce);
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost/login?error=expired');
    expect(result.cookie).toBe('');
    expect(result.setCookies).toEqual([CLEARED_NONCE]);
  });

  it('sends a handoff token past its expiry to the expired error', async () => {
    const { state, nonce } = await start('');
    const expired = jwt.sign(
      {
        typ: 'self-hosted-broker',
        email: 'owner@example.com',
        name: 'Owner',
        avatarUrl: null,
        provider: 'google',
        providerId: 'g-owner',
        state,
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: 'brk-test',
        issuer: 'betterdb-entitlement',
        audience: 'http://localhost',
        expiresIn: -10,
      },
    );
    const result = await callback(expired, nonce);
    expect(result.location).toBe('http://localhost/login?error=expired');
    expect(result.cookie).toBe('');
  });

  it('rejects a token issued for another audience', async () => {
    const { state, nonce } = await start('');
    const result = await callback(tokenFor(state, {}, 'http://evil.example'), nonce);
    expect(result.location).toBe('http://localhost/login?error=invalid');
    expect(result.cookie).toBe('');
  });

  it('rejects a token signed by an untrusted key and a missing token', async () => {
    const { state, nonce } = await start('');
    const forged = await callback(tokenFor(state, {}, 'http://localhost', foreignKey), nonce);
    expect(forged.location).toBe('http://localhost/login?error=invalid');

    const missing = await app.inject({
      method: 'GET',
      url: '/auth/broker/callback',
      remoteAddress: nextIp(),
    });
    expect(missing.statusCode).toBe(302);
    expect(String(missing.headers.location)).toBe('http://localhost/login?error=invalid');
  });

  it('refuses a callback that arrives without the nonce cookie from start', async () => {
    const { state } = await start('');
    const result = await callback(tokenFor(state));
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost/login?error=invalid');
    expect(result.cookie).toBe('');
    expect(result.setCookies).toEqual([CLEARED_NONCE]);
  });

  it("refuses a callback carrying another browser's nonce cookie", async () => {
    const attacker = await start('');
    const victim = await start('');
    const result = await callback(tokenFor(attacker.state), victim.nonce);
    expect(result.location).toBe('http://localhost/login?error=invalid');
    expect(result.cookie).toBe('');
  });

  it('refuses a stranger without an invitation', async () => {
    const { state, nonce } = await start('');
    const result = await callback(
      tokenFor(state, { email: 'stranger@example.com', providerId: 'g-stranger' }),
      nonce,
    );
    expect(result.location).toBe('http://localhost/login?error=not_invited');
    expect(result.cookie).toBe('');
    expect(await members.findByEmail('stranger@example.com')).toBeNull();
  });

  it('admits an invitee with the invitation role', async () => {
    const { token } = await app.get(InvitationService).create({
      email: 'invitee@example.com',
      role: 'admin',
      invitedBy: ownerId,
    });
    const { state, nonce } = await start(`?invite=${encodeURIComponent(token)}`);
    const result = await callback(
      tokenFor(state, {
        email: 'invitee@example.com',
        name: 'Invitee',
        providerId: 'g-invitee',
      }),
      nonce,
    );
    expect(result.location).toBe('http://localhost/');
    expect(result.cookie).toContain(SESSION_COOKIE);
    const invitee = await members.findByEmail('invitee@example.com');
    expect(invitee?.role).toBe('admin');
    expect(invitee?.isOwner).toBe(false);
    expect(built.telemetry.trackInviteAccepted).toHaveBeenCalledWith({
      role: 'admin',
      method: 'broker',
    });
  });

  it('signs a returning member in and drops an off-site next', async () => {
    const { state, nonce } = await start('?next=%2F%2Fevil.example');
    const result = await callback(tokenFor(state), nonce);
    expect(result.location).toBe('http://localhost/');
    expect(result.cookie).toContain(SESSION_COOKIE);
    expect(built.telemetry.trackUserLogin).toHaveBeenCalledWith({ method: 'broker' });
    expect(await latestLogin()).toEqual({
      actorEmail: 'owner@example.com',
      details: { method: 'google', provider: 'google' },
    });
  });

  it('drops a next carrying CR/LF instead of failing on the Location header', async () => {
    const { state, nonce } = await start('?next=%2F%0D%0Aset-cookie%3A%20x%3D1');
    const result = await callback(tokenFor(state), nonce);
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost/');
    expect(result.cookie).toContain(SESSION_COOKIE);
  });

  it('ends an unexpected callback failure on the invalid error, not a 500', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      return undefined;
    });
    jest
      .spyOn(app.get(BrokerUserResolver), 'signIn')
      .mockRejectedValueOnce(new Error('database unavailable'));
    const { state, nonce } = await start('');
    const result = await callback(tokenFor(state), nonce);
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost/login?error=invalid');
    expect(result.cookie).toBe('');
    expect(result.setCookies).toEqual([CLEARED_NONCE]);
    expect(errorLog).toHaveBeenCalled();
  });

  it('signs in when the request host carries an explicit default port', async () => {
    const devConfig = resolveWorkspaceConfig({
      AUTH_BROKER_URL: 'https://broker.example',
      AUTH_BROKER_PUBLIC_KEY: publicKey,
      AUTH_BROKER_KEY_ID: 'brk-test',
    });
    const withDefaultPort = await buildApp(devConfig);
    try {
      const startResponse = await withDefaultPort.app.inject({
        method: 'GET',
        url: '/auth/broker/start',
        headers: { host: 'localhost:80' },
      });
      expect(startResponse.statusCode).toBe(302);
      const location = new URL(String(startResponse.headers.location));
      const redirect = new URL(String(location.searchParams.get('redirect')));
      const state = String(location.searchParams.get('state'));
      const nonce = cookieNamed(startResponse.headers['set-cookie'], `${BROKER_NONCE_COOKIE}=`);
      const callbackResponse = await withDefaultPort.app.inject({
        method: 'GET',
        url: `/auth/broker/callback?token=${encodeURIComponent(tokenFor(state, {}, redirect.origin))}`,
        headers: { host: 'localhost:80', cookie: nonce },
        remoteAddress: nextIp(),
      });
      expect(callbackResponse.statusCode).toBe(302);
      expect(cookieNamed(callbackResponse.headers['set-cookie'], SESSION_COOKIE)).toContain(
        SESSION_COOKIE,
      );
    } finally {
      await withDefaultPort.app.close();
      await withDefaultPort.storage.close();
    }
  });

  it('marks the nonce cookie Secure and scopes it to the production auth path', async () => {
    const secure = await buildApp(
      resolveWorkspaceConfig({
        ...BASE_ENV,
        NODE_ENV: 'production',
        AUTH_PUBLIC_URL: 'https://monitor.example',
      }),
    );
    try {
      const response = await secure.app.inject({ method: 'GET', url: '/auth/broker/start' });
      expect(response.statusCode).toBe(302);
      const [cookie] = allCookies(response.headers['set-cookie']);
      expect(cookie).toMatch(/; Path=\/api\/auth; Max-Age=600; HttpOnly; SameSite=Lax; Secure$/);
    } finally {
      await secure.app.close();
      await secure.storage.close();
    }
  });

  it('rejects start with a malformed Host header and creates no state', async () => {
    const devConfig = resolveWorkspaceConfig({
      AUTH_BROKER_URL: 'https://broker.example',
      AUTH_BROKER_PUBLIC_KEY: publicKey,
      AUTH_BROKER_KEY_ID: 'brk-test',
    });
    const withBadHost = await buildApp(devConfig);
    try {
      const states = withBadHost.app.get(BrokerStateStore);
      const createSpy = jest.spyOn(states, 'create');
      const response = await withBadHost.app.inject({
        method: 'GET',
        url: '/auth/broker/start',
        headers: { host: 'bad host' },
      });
      expect(response.statusCode).toBe(400);
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      await withBadHost.app.close();
      await withBadHost.storage.close();
    }
  });

  it('redirects callback to the invalid-error location on a malformed Host header', async () => {
    const devConfig = resolveWorkspaceConfig({
      AUTH_BROKER_URL: 'https://broker.example',
      AUTH_BROKER_PUBLIC_KEY: publicKey,
      AUTH_BROKER_KEY_ID: 'brk-test',
    });
    const withBadHost = await buildApp(devConfig);
    try {
      const response = await withBadHost.app.inject({
        method: 'GET',
        url: '/auth/broker/callback?token=anything',
        headers: { host: 'bad host' },
        remoteAddress: nextIp(),
      });
      expect(response.statusCode).toBe(302);
      expect(String(response.headers.location)).toBe('http://localhost:5173/login?error=invalid');
    } finally {
      await withBadHost.app.close();
      await withBadHost.storage.close();
    }
  });

  it('ignores a malformed Host header when a public URL is configured', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/broker/start',
      headers: { host: 'bad host' },
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    expect(location.searchParams.get('redirect')).toBe('http://localhost/auth/broker/callback');
  });

  it('returns a cancelled sign-in to the app origin stored with its state', async () => {
    const devConfig = resolveWorkspaceConfig({
      AUTH_BROKER_URL: 'https://broker.example',
      AUTH_BROKER_PUBLIC_KEY: publicKey,
      AUTH_BROKER_KEY_ID: 'brk-test',
    });
    const dev = await buildApp(devConfig);
    try {
      const started = await dev.app.inject({
        method: 'GET',
        url: '/auth/broker/start',
        headers: { host: 'localhost:3001' },
      });
      const location = new URL(String(started.headers.location));
      expect(location.searchParams.get('redirect')).toBe(
        'http://localhost:3001/auth/broker/callback',
      );
      const state = String(location.searchParams.get('state'));
      const nonce = cookieNamed(started.headers['set-cookie'], `${BROKER_NONCE_COOKIE}=`);
      const stateSpy = jest.spyOn(dev.app.get(BrokerStateStore), 'consume');

      const cancelled = await dev.app.inject({
        method: 'GET',
        url: `/auth/broker/cancel?state=${state}`,
        headers: { host: 'localhost:3001', cookie: nonce },
        remoteAddress: nextIp(),
      });
      expect(cancelled.statusCode).toBe(302);
      expect(String(cancelled.headers.location)).toBe('http://localhost:5173/login');
      expect(allCookies(cancelled.headers['set-cookie'])).toEqual([CLEARED_NONCE]);
      expect(stateSpy).toHaveBeenCalledWith(state);
      expect(await stateSpy.mock.results[0].value).not.toBeNull();
      expect(await dev.app.get(BrokerStateStore).consume(state)).toBeNull();
    } finally {
      await dev.app.close();
      await dev.storage.close();
    }
  });

  it('keeps the state of a cancel that arrives without its nonce cookie', async () => {
    const { state } = await start('');
    const stateSpy = jest.spyOn(app.get(BrokerStateStore), 'consume');
    const cancelled = await app.inject({
      method: 'GET',
      url: `/auth/broker/cancel?state=${state}`,
      remoteAddress: nextIp(),
    });
    expect(cancelled.statusCode).toBe(302);
    expect(String(cancelled.headers.location)).toBe('http://localhost/login');
    expect(stateSpy).not.toHaveBeenCalled();
  });

  it("falls back to the configured login page for another browser's cancel", async () => {
    const attacker = await start('');
    const victim = await start('');
    const cancelled = await app.inject({
      method: 'GET',
      url: `/auth/broker/cancel?state=${attacker.state}`,
      headers: { cookie: victim.nonce },
      remoteAddress: nextIp(),
    });
    expect(cancelled.statusCode).toBe(302);
    expect(String(cancelled.headers.location)).toBe('http://localhost/login');
  });

  it('answers 404 on every route when the broker is disabled', async () => {
    const disabled = await buildApp(
      resolveWorkspaceConfig({ ...BASE_ENV, AUTH_BROKER_DISABLED: 'true' }),
    );
    try {
      const startResponse = await disabled.app.inject({
        method: 'GET',
        url: '/auth/broker/start',
      });
      expect(startResponse.statusCode).toBe(404);
      const callbackResponse = await disabled.app.inject({
        method: 'GET',
        url: '/auth/broker/callback?token=anything',
        remoteAddress: nextIp(),
      });
      expect(callbackResponse.statusCode).toBe(404);
      const cancelResponse = await disabled.app.inject({
        method: 'GET',
        url: '/auth/broker/cancel',
        remoteAddress: nextIp(),
      });
      expect(cancelResponse.statusCode).toBe(404);
    } finally {
      await disabled.app.close();
      await disabled.storage.close();
    }
  });
});

describe('BrokerController throttling', () => {
  it('limits start and callback to 20 requests a minute per client', async () => {
    const throttled = await buildApp(resolveWorkspaceConfig(BASE_ENV), { throttled: true });
    try {
      const startStatuses: number[] = [];
      const callbackStatuses: number[] = [];
      for (let attempt = 0; attempt < 21; attempt++) {
        const startResponse = await throttled.app.inject({
          method: 'GET',
          url: '/auth/broker/start',
          remoteAddress: '203.0.113.7',
        });
        startStatuses.push(startResponse.statusCode);
        const callbackResponse = await throttled.app.inject({
          method: 'GET',
          url: '/auth/broker/callback',
          remoteAddress: '203.0.113.8',
        });
        callbackStatuses.push(callbackResponse.statusCode);
      }
      expect(
        startStatuses.slice(0, 20).every((status) => {
          return status === 302;
        }),
      ).toBe(true);
      expect(startStatuses[20]).toBe(429);
      expect(
        callbackStatuses.slice(0, 20).every((status) => {
          return status === 302;
        }),
      ).toBe(true);
      expect(callbackStatuses[20]).toBe(429);
    } finally {
      await throttled.app.close();
      await throttled.storage.close();
    }
  });
});

interface SignInOptions {
  query?: string;
  claims?: Record<string, unknown>;
  headers?: Record<string, string>;
  cookie?: string;
}

async function signInThrough(
  target: NestFastifyApplication,
  options: SignInOptions = {},
): Promise<CallbackResult> {
  const started = await target.inject({
    method: 'GET',
    url: `/auth/broker/start${options.query ?? ''}`,
  });
  const state = String(new URL(String(started.headers.location)).searchParams.get('state'));
  const nonce = cookieNamed(started.headers['set-cookie'], `${BROKER_NONCE_COOKIE}=`);
  const cookie = options.cookie === undefined ? nonce : `${nonce}; ${options.cookie}`;
  const response = await target.inject({
    method: 'GET',
    url: `/auth/broker/callback?token=${encodeURIComponent(tokenFor(state, options.claims))}`,
    remoteAddress: nextIp(),
    headers: { ...options.headers, cookie },
  });
  return {
    status: response.statusCode,
    location: String(response.headers.location),
    cookie: cookieNamed(response.headers['set-cookie'], SESSION_COOKIE),
    setCookies: allCookies(response.headers['set-cookie']),
  };
}

const INVITEE_CLAIMS = { email: 'invitee@example.com', name: 'Invitee', providerId: 'g-invitee' };

const SESSION_FAILURES: Array<[string, () => Promise<Response>]> = [
  [
    'answers with a failure',
    () => {
      return Promise.resolve(new Response(null, { status: 500 }));
    },
  ],
  [
    'throws',
    () => {
      return Promise.reject(new Error('session store unavailable'));
    },
  ],
];

describe('BrokerController when the session cannot be started', () => {
  let built: BuiltApp;
  let app: NestFastifyApplication;
  let members: MemberService;
  let invitations: InvitationService;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    built = await buildApp(resolveWorkspaceConfig(BASE_ENV));
    app = built.app;
    members = app.get(MemberService);
    invitations = app.get(InvitationService);
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      return undefined;
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
    await built.storage.close();
  });

  async function invitationStatus(id: string): Promise<string | undefined> {
    const rows = await invitations.list();
    return rows.find((row) => {
      return row.id === id;
    })?.status;
  }

  async function inviteToken(): Promise<{ token: string; id: string }> {
    const owner = await members.findByEmail('owner@example.com');
    const created = await invitations.create({
      email: INVITEE_CLAIMS.email,
      role: 'member',
      invitedBy: String(owner?.id),
    });
    return { token: created.token, id: created.invitation.id };
  }

  it.each(SESSION_FAILURES)(
    'undoes the first owner when starting the session %s',
    async (_label, failure) => {
      jest.spyOn(members, 'startSession').mockImplementationOnce(failure);
      const failed = await signInThrough(app);
      expect(failed.status).toBe(302);
      expect(failed.location).toBe('http://localhost/login?error=invalid');
      expect(failed.cookie).toBe('');
      expect(await members.count()).toBe(0);
      expect(built.telemetry.trackWorkspaceFirstRegister).not.toHaveBeenCalled();

      const retried = await signInThrough(app);
      expect(retried.cookie).toContain(SESSION_COOKIE);
      expect(await members.findByEmail('owner@example.com')).toMatchObject({ isOwner: true });
      expect(built.telemetry.trackWorkspaceFirstRegister).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SESSION_FAILURES)(
    'undoes an invited member and reopens the invitation when starting the session %s',
    async (_label, failure) => {
      await signInThrough(app);
      const invite = await inviteToken();
      const query = `?invite=${encodeURIComponent(invite.token)}`;
      jest.spyOn(members, 'startSession').mockImplementationOnce(failure);
      const failed = await signInThrough(app, { query, claims: INVITEE_CLAIMS });
      expect(failed.location).toBe('http://localhost/login?error=invalid');
      expect(failed.cookie).toBe('');
      expect(await members.findByEmail(INVITEE_CLAIMS.email)).toBeNull();
      expect(await invitationStatus(invite.id)).toBe('pending');
      expect(built.telemetry.trackInviteAccepted).not.toHaveBeenCalled();

      const retried = await signInThrough(app, { query, claims: INVITEE_CLAIMS });
      expect(retried.cookie).toContain(SESSION_COOKIE);
      expect(await members.findByEmail(INVITEE_CLAIMS.email)).toMatchObject({ role: 'member' });
      expect(await invitationStatus(invite.id)).toBe('accepted');
      expect(built.telemetry.trackInviteAccepted).toHaveBeenCalledTimes(1);
    },
  );

  it.each(SESSION_FAILURES)(
    'keeps a returning member when starting the session %s',
    async (_label, failure) => {
      await signInThrough(app);
      const owner = await members.findByEmail('owner@example.com');
      const remove = jest.spyOn(members, 'remove');
      const discard = jest.spyOn(members, 'discardBootstrapOwner');
      jest.spyOn(members, 'startSession').mockImplementationOnce(failure);
      const failed = await signInThrough(app);
      expect(failed.location).toBe('http://localhost/login?error=invalid');
      expect(failed.cookie).toBe('');
      expect(await members.findByEmail('owner@example.com')).toEqual(owner);
      expect(remove).not.toHaveBeenCalled();
      expect(discard).not.toHaveBeenCalled();
    },
  );

  it('still redirects to the invalid error and logs when undoing the sign-in fails', async () => {
    jest.spyOn(members, 'startSession').mockImplementationOnce(SESSION_FAILURES[0][1]);
    jest.spyOn(members, 'discardBootstrapOwner').mockRejectedValueOnce(new Error('disk full'));
    const failed = await signInThrough(app);
    expect(failed.status).toBe(302);
    expect(failed.location).toBe('http://localhost/login?error=invalid');
    expect(failed.setCookies).toEqual([CLEARED_NONCE]);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('owner@example.com'),
      expect.stringContaining('disk full'),
    );
  });

  it('keeps the invitation accepted when removing the invited member fails', async () => {
    await signInThrough(app);
    const invite = await inviteToken();
    jest.spyOn(members, 'startSession').mockImplementationOnce(SESSION_FAILURES[0][1]);
    jest.spyOn(members, 'remove').mockRejectedValueOnce(new Error('member vanished'));
    const failed = await signInThrough(app, {
      query: `?invite=${encodeURIComponent(invite.token)}`,
      claims: INVITEE_CLAIMS,
    });
    expect(failed.location).toBe('http://localhost/login?error=invalid');
    expect(await invitationStatus(invite.id)).toBe('accepted');
    expect(await members.findByEmail(INVITEE_CLAIMS.email)).not.toBeNull();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining(INVITEE_CLAIMS.email),
      expect.stringContaining('member vanished'),
    );
  });

  async function raceRetryAgainstFailedStart(
    options: SignInOptions = {},
  ): Promise<[CallbackResult, CallbackResult]> {
    let entered: () => void = () => {
      return undefined;
    };
    const startEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let failStart: () => void = () => {
      return undefined;
    };
    const failGate = new Promise<void>((resolve) => {
      failStart = resolve;
    });
    jest.spyOn(members, 'startSession').mockImplementationOnce(async () => {
      entered();
      await failGate;
      return new Response(null, { status: 500 });
    });
    const first = signInThrough(app, options);
    await startEntered;
    const retry = signInThrough(app, options);
    await Promise.race([
      retry,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      }),
    ]);
    failStart();
    return Promise.all([first, retry]);
  }

  async function signedInEmail(cookie: string): Promise<string | null> {
    const me = await app.inject({ method: 'GET', url: '/workspace/me', headers: { cookie } });
    if (me.statusCode !== 200) {
      return null;
    }
    return (me.json() as { email: string }).email;
  }

  it('keeps the owner a concurrent retry signed in when the first session fails', async () => {
    const [failed, retried] = await raceRetryAgainstFailedStart();
    expect(failed.location).toBe('http://localhost/login?error=invalid');
    expect(failed.cookie).toBe('');
    expect(retried.cookie).toContain(SESSION_COOKIE);
    expect(await members.count()).toBe(1);
    expect(await members.findByEmail('owner@example.com')).toMatchObject({ isOwner: true });
    expect(await signedInEmail(retried.cookie)).toBe('owner@example.com');
  });

  it('keeps the invitee a concurrent retry signed in when the first session fails', async () => {
    await signInThrough(app);
    const invite = await inviteToken();
    const [failed, retried] = await raceRetryAgainstFailedStart({
      query: `?invite=${encodeURIComponent(invite.token)}`,
      claims: INVITEE_CLAIMS,
    });
    expect(failed.location).toBe('http://localhost/login?error=invalid');
    expect(failed.cookie).toBe('');
    expect(retried.cookie).toContain(SESSION_COOKIE);
    expect(await members.findByEmail(INVITEE_CLAIMS.email)).toMatchObject({ role: 'member' });
    expect(await invitationStatus(invite.id)).toBe('accepted');
    expect(await signedInEmail(retried.cookie)).toBe(INVITEE_CLAIMS.email);
  });
});

describe('BrokerController callback from a real browser', () => {
  it('mints a session despite cross-site navigation headers and a stale session cookie', async () => {
    const browser = await buildApp(resolveWorkspaceConfig(BASE_ENV));
    try {
      const first = await signInThrough(browser.app);
      expect(first.cookie).toContain(SESSION_COOKIE);
      const owner = await browser.app.get(MemberService).findByEmail('owner@example.com');
      const auth = browser.app.get(BETTER_AUTH) as Awaited<ReturnType<typeof createBetterAuth>>;
      const context = await auth.$context;
      const sessions = await context.internalAdapter.listSessions(String(owner?.id));
      await context.internalAdapter.deleteSessions(
        sessions.map((session) => {
          return session.token;
        }),
      );
      const staleCheck = await browser.app.inject({
        method: 'GET',
        url: '/workspace/me',
        headers: { cookie: first.cookie },
      });
      expect(staleCheck.statusCode).toBe(401);

      const result = await signInThrough(browser.app, {
        query: '?next=%2Fsettings',
        cookie: first.cookie,
        headers: {
          referer: 'https://broker.example/self-hosted/sign-in',
          origin: 'https://broker.example',
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36',
        },
      });
      expect(result.status).toBe(302);
      expect(result.location).toBe('http://localhost/settings');
      expect(result.cookie).toContain(SESSION_COOKIE);
      expect(result.cookie).not.toBe(first.cookie);
      expect(result.setCookies).toContain(CLEARED_NONCE);

      const me = await browser.app.inject({
        method: 'GET',
        url: '/workspace/me',
        headers: { cookie: result.cookie },
      });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { email: string }).email).toBe('owner@example.com');
    } finally {
      await browser.app.close();
      await browser.storage.close();
    }
  });
});

describe('BrokerController first owner versus password sign-up', () => {
  it('leaves exactly one owner when both reach an empty workspace at once', async () => {
    const racing = await buildApp(resolveWorkspaceConfig(BASE_ENV));
    try {
      const startResponse = await racing.app.inject({
        method: 'GET',
        url: '/auth/broker/start',
        remoteAddress: nextIp(),
      });
      const state = String(
        new URL(String(startResponse.headers.location)).searchParams.get('state'),
      );
      const nonce = cookieNamed(startResponse.headers['set-cookie'], `${BROKER_NONCE_COOKIE}=`);
      const memberService = racing.app.get(MemberService);
      const realCount = memberService.count.bind(memberService);
      let brokerCounted: () => void = () => {
        return undefined;
      };
      const counted = new Promise<void>((resolve) => {
        brokerCounted = resolve;
      });
      let releaseBroker: () => void = () => {
        return undefined;
      };
      const brokerGate = new Promise<void>((resolve) => {
        releaseBroker = resolve;
      });
      jest.spyOn(memberService, 'count').mockImplementationOnce(async () => {
        const total = await realCount();
        brokerCounted();
        await brokerGate;
        return total;
      });

      const brokerCallback = racing.app.inject({
        method: 'GET',
        url: `/auth/broker/callback?token=${encodeURIComponent(tokenFor(state))}`,
        remoteAddress: nextIp(),
        headers: { cookie: nonce },
      });
      await counted;
      const signUp = racing.app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        remoteAddress: nextIp(),
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        payload: {
          email: 'password@example.com',
          password: 'correct horse battery',
          name: 'Password',
        },
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      releaseBroker();
      const [signUpResponse, callbackResponse] = await Promise.all([signUp, brokerCallback]);

      const everyone = await memberService.list();
      const owners = everyone.filter((member) => {
        return member.isOwner === true;
      });
      expect(owners).toHaveLength(1);
      expect(everyone).toHaveLength(1);
      expect(everyone[0].email).toBe('owner@example.com');
      expect(signUpResponse.statusCode).toBe(403);
      expect(String(callbackResponse.headers.location)).toBe('http://localhost/');
    } finally {
      await racing.app.close();
      await racing.storage.close();
    }
  });
});
