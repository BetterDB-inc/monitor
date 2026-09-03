import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { StorageModule } from '../storage/storage.module';
import { ActorResolver } from './actor-resolver';
import { WorkspaceAuthModule } from './workspace-auth.module';
import { SystemModule } from '../system/system.module';

async function boot(env: Record<string, string | undefined>): Promise<NestFastifyApplication> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const moduleRef = await Test.createTestingModule({
    imports: [StorageModule, WorkspaceAuthModule.forRoot(), SystemModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('WorkspaceAuthModule', () => {
  afterEach(() => {
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.CLOUD_MODE;
  });

  it('mounts nothing but the guard when disabled', async () => {
    const app = await boot({ WORKSPACE_DISABLED: 'true', STORAGE_TYPE: 'memory' });
    expect((await app.inject({ method: 'GET', url: '/auth/get-session' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/workspace/me' })).statusCode).toBe(404);
    const status = await app.inject({ method: 'GET', url: '/system/workspace' });
    expect(status.json()).toEqual({ mode: 'disabled', enabled: false, bootstrapped: false });
    await app.close();
  });

  it('mounts auth and workspace routes when enabled', async () => {
    const app = await boot({
      WORKSPACE_DISABLED: undefined,
      STORAGE_TYPE: 'memory',
      AUTH_SECRET: 's'.repeat(40),
    });
    expect((await app.inject({ method: 'GET', url: '/auth/get-session' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/workspace/me' })).statusCode).toBe(401);
    const status = await app.inject({ method: 'GET', url: '/system/workspace' });
    expect(status.json()).toEqual({ mode: 'self-hosted', enabled: true, bootstrapped: false });
    await app.close();
  });

  it('boots when BETTERDB_DATA_DIR is set to an empty string', async () => {
    const previous = process.env.BETTERDB_DATA_DIR;
    process.env.BETTERDB_DATA_DIR = '';
    try {
      const app = await boot({
        WORKSPACE_DISABLED: undefined,
        STORAGE_TYPE: 'memory',
        AUTH_SECRET: undefined,
      });
      expect((await app.inject({ method: 'GET', url: '/auth/get-session' })).statusCode).toBe(200);
      await app.close();
    } finally {
      if (previous === undefined) {
        delete process.env.BETTERDB_DATA_DIR;
      } else {
        process.env.BETTERDB_DATA_DIR = previous;
      }
    }
  });

  it('warns once that memory storage loses users and sessions on restart', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {
      return undefined;
    });
    try {
      const app = await boot({
        WORKSPACE_DISABLED: undefined,
        STORAGE_TYPE: 'memory',
        AUTH_SECRET: 's'.repeat(40),
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('STORAGE_TYPE=memory'));
      await app.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('signs out through the public auth path and then rejects workspace/me', async () => {
    const app = await boot({
      WORKSPACE_DISABLED: undefined,
      STORAGE_TYPE: 'memory',
      AUTH_SECRET: 's'.repeat(40),
    });
    const signUp = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      payload: { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const cookieHeader = Array.isArray(cookie) ? cookie[0].split(';')[0] : cookie?.split(';')[0];

    const signOut = await app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: { cookie: cookieHeader ?? '', origin: 'http://localhost:5173' },
    });
    expect(signOut.statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/workspace/me',
      headers: { cookie: cookieHeader ?? '' },
    });
    expect(me.statusCode).toBe(401);
    await app.close();
  });

  it('provides ActorResolver from the module when disabled', async () => {
    const app = await boot({ WORKSPACE_DISABLED: 'true', STORAGE_TYPE: 'memory' });
    expect(app.get(ActorResolver).isEnabled()).toBe(false);
    await app.close();
  });
});
