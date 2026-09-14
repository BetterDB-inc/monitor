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
      .spyOn(app.get(BrokerUserResolver), 'resolve')
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

  it('answers 404 on both routes when the broker is disabled', async () => {
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
