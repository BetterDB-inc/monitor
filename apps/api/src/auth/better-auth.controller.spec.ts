import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { BETTER_AUTH, countUsers, createBetterAuth } from './better-auth.factory';
import { BetterAuthController } from './better-auth.controller';
import { resolveWorkspaceConfig } from './workspace-config';

describe('BetterAuthController', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController],
      providers: [{ provide: BETTER_AUTH, useValue: auth }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('forwards sign-up and returns the session cookie', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      payload: { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' },
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toContain('session_token');
    expect(response.json().user.email).toBe('owner@example.com');
  });

  it('forwards a GET without a body', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/get-session' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('null');
  });

  it('forwards a wrong password as 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      payload: { email: 'owner@example.com', password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('keys rate limits on the socket address, not a client-supplied header', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/sign-in/email',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost',
          'x-betterdb-client-ip': `10.0.0.${attempt}`,
        },
        payload: { email: 'owner@example.com', password: 'wrong' },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(429);
  });
});

describe('BetterAuthController sign-up serialisation', () => {
  let app: NestFastifyApplication;
  let auth: Awaited<ReturnType<typeof createBetterAuth>>;

  beforeAll(async () => {
    auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 'r'.repeat(40),
      config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' }),
    });
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController],
      providers: [{ provide: BETTER_AUTH, useValue: auth }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('promotes exactly one owner when two sign-ups arrive concurrently', async () => {
    const signUp = (email: string, remoteAddress: string) => {
      return app.inject({
        method: 'POST',
        url: '/auth/sign-up/email',
        remoteAddress,
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        payload: { email, password: 'correct horse battery', name: email },
      });
    };

    const [first, second] = await Promise.all([
      signUp('race-one@example.com', '198.51.100.11'),
      signUp('race-two@example.com', '198.51.100.12'),
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 403]);

    const rejected = first.statusCode === 403 ? first : second;
    expect(rejected.body).toContain('Registration is closed');

    expect(await countUsers(auth)).toBe(1);

    const context = await auth.$context;
    const users = await context.adapter.findMany<{ role: string; isOwner: boolean }>({
      model: 'user',
    });
    expect(users).toHaveLength(1);
    expect(users[0].role).toBe('admin');
    expect(users[0].isOwner).toBe(true);
  });
});
