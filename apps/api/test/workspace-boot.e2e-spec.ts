import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };

const TOUCHED = [
  'WORKSPACE_DISABLED',
  'NODE_ENV',
  'BETTERDB_DATA_DIR',
  'AUTH_PUBLIC_URL',
  'AUTH_SECRET',
  'STORAGE_TYPE',
  'STORAGE_SQLITE_FILEPATH',
];

describe('Workspace boot smoke (E2E)', () => {
  let app: NestFastifyApplication;
  let sessionCookie: string;
  const previous = new Map<string, string | undefined>();
  const sqlitePath = join(tmpdir(), `workspace-boot-${Date.now()}.db`);

  beforeAll(async () => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.AUTH_PUBLIC_URL;
    delete process.env.AUTH_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.BETTERDB_DATA_DIR = '';
    process.env.STORAGE_TYPE = 'sqlite';
    process.env.STORAGE_SQLITE_FILEPATH = sqlitePath;

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
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(sqlitePath, { force: true });
  });

  it('reports an un-bootstrapped workspace before any user exists', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/system/workspace' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mode: 'self-hosted',
      enabled: true,
      bootstrapped: false,
    });
  });

  it('signs the first user up with a cookie the browser keeps over plain HTTP', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: '198.51.100.80',
      headers: { 'content-type': 'application/json' },
      payload: OWNER,
    });
    expect(response.statusCode).toBe(200);
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []).join('\n');
    expect(cookies).toContain('better-auth.session_token');
    expect(cookies).not.toContain('__Secure-');
    expect(cookies).not.toContain('Secure');
    sessionCookie = cookies.split(';')[0];
  });

  it('returns the owner for the session cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/me',
      headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ email: OWNER.email, role: 'admin', isOwner: true }),
    );
  });

  it('rejects a guarded route without the session cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/connections' });
    expect(response.statusCode).toBe(401);
  });
});
