import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { BETTER_AUTH, createBetterAuth } from '../auth/better-auth.factory';
import { BetterAuthController } from '../auth/better-auth.controller';
import { ActorResolver } from '../auth/actor-resolver';
import { ActorGuard } from '../auth/guards/actor.guard';
import { resolveWorkspaceConfig, WORKSPACE_CONFIG } from '../auth/workspace-config';
import { WorkspaceController } from './workspace.controller';

describe('GET /workspace/me', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController, WorkspaceController],
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        ActorResolver,
        { provide: APP_GUARD, useClass: ActorGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 401 without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/workspace/me' });
    expect(response.statusCode).toBe(401);
  });

  it('returns the signed-in owner', async () => {
    const signUp = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      payload: { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' },
      remoteAddress: '10.1.9.1',
    });
    const cookie = String(signUp.headers['set-cookie']).split(';')[0];
    const response = await app.inject({
      method: 'GET',
      url: '/workspace/me',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: expect.any(String),
      email: 'owner@example.com',
      name: 'Owner',
      role: 'admin',
      isOwner: true,
    });
  });
});
