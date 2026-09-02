import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { StorageModule } from '../storage/storage.module';
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
});
