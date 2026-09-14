import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
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
import { BetterAuthController } from '../better-auth.controller';
import { BETTER_AUTH, createBetterAuth } from '../better-auth.factory';
import { ActorGuard } from '../guards/actor.guard';
import { MutationGuard } from '../guards/mutation.guard';
import { RolesGuard } from '../guards/roles.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG, WorkspaceConfig } from '../workspace-config';
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

let ipCounter = 0;

function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

async function buildApp(config: WorkspaceConfig): Promise<BuiltApp> {
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
  const moduleRef = await Test.createTestingModule({
    controllers: [BrokerController, BetterAuthController, WorkspaceController],
    providers: [
      { provide: BETTER_AUTH, useValue: auth },
      { provide: WORKSPACE_CONFIG, useValue: config },
      { provide: 'STORAGE_CLIENT', useValue: storage },
      { provide: UsageTelemetryService, useValue: telemetry },
      { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
      ActivityService,
      ActorResolver,
      MemberService,
      InvitationService,
      BrokerStateStore,
      BrokerUserResolver,
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

  async function start(query: string): Promise<{ state: string; location: URL }> {
    const response = await app.inject({ method: 'GET', url: `/auth/broker/start${query}` });
    expect(response.statusCode).toBe(302);
    const location = new URL(String(response.headers.location));
    return { state: String(location.searchParams.get('state')), location };
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

  async function callback(
    token: string,
  ): Promise<{ status: number; location: string; cookie: string }> {
    const response = await app.inject({
      method: 'GET',
      url: `/auth/broker/callback?token=${encodeURIComponent(token)}`,
      remoteAddress: nextIp(),
    });
    return {
      status: response.statusCode,
      location: String(response.headers.location),
      cookie: String(response.headers['set-cookie'] ?? '').split(';')[0],
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
    const { state, location } = await start('?provider=google&next=%2Fsettings');
    expect(location.origin).toBe('https://broker.example');
    expect(location.pathname).toBe('/self-hosted/sign-in');
    expect(location.searchParams.get('redirect')).toBe('http://localhost/auth/broker/callback');
    expect(location.searchParams.get('provider')).toBe('google');
    expect(state).toHaveLength(43);
    ownerToken = tokenFor(state);
  });

  it('omits an unknown provider from the broker redirect', async () => {
    const { location } = await start('?provider=gitlab');
    expect(location.searchParams.has('provider')).toBe(false);
  });

  it('registers the first broker user as owner and signs them in', async () => {
    const result = await callback(ownerToken);
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost/settings');
    expect(result.cookie).toContain('better-auth.session_token=');

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
      method: 'google',
    });
  });

  it('rejects a replayed token as expired', async () => {
    const result = await callback(ownerToken);
    expect(result.status).toBe(302);
    expect(result.location).toBe('http://localhost/login?error=expired');
    expect(result.cookie).toBe('');
  });

  it('rejects a token issued for another audience', async () => {
    const { state } = await start('');
    const result = await callback(tokenFor(state, {}, 'http://evil.example'));
    expect(result.location).toBe('http://localhost/login?error=invalid');
    expect(result.cookie).toBe('');
  });

  it('rejects a token signed by an untrusted key and a missing token', async () => {
    const { state } = await start('');
    const forged = await callback(tokenFor(state, {}, 'http://localhost', foreignKey));
    expect(forged.location).toBe('http://localhost/login?error=invalid');

    const missing = await app.inject({
      method: 'GET',
      url: '/auth/broker/callback',
      remoteAddress: nextIp(),
    });
    expect(missing.statusCode).toBe(302);
    expect(String(missing.headers.location)).toBe('http://localhost/login?error=invalid');
  });

  it('refuses a stranger without an invitation', async () => {
    const { state } = await start('');
    const result = await callback(
      tokenFor(state, { email: 'stranger@example.com', providerId: 'g-stranger' }),
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
    const { state } = await start(`?invite=${encodeURIComponent(token)}`);
    const result = await callback(
      tokenFor(state, {
        email: 'invitee@example.com',
        name: 'Invitee',
        providerId: 'g-invitee',
      }),
    );
    expect(result.location).toBe('http://localhost/');
    expect(result.cookie).toContain('better-auth.session_token=');
    const invitee = await members.findByEmail('invitee@example.com');
    expect(invitee?.role).toBe('admin');
    expect(invitee?.isOwner).toBe(false);
    expect(built.telemetry.trackInviteAccepted).toHaveBeenCalledWith({
      role: 'admin',
      method: 'google',
    });
  });

  it('signs a returning member in and drops an off-site next', async () => {
    const { state } = await start('?next=%2F%2Fevil.example');
    const result = await callback(tokenFor(state));
    expect(result.location).toBe('http://localhost/');
    expect(result.cookie).toContain('better-auth.session_token=');
    expect(built.telemetry.trackUserLogin).toHaveBeenCalledWith({ method: 'google' });
    expect(await latestLogin()).toEqual({
      actorEmail: 'owner@example.com',
      details: { method: 'google', provider: 'google' },
    });
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
