import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { MemoryAdapter } from '../storage/adapters/memory.adapter';
import { ACTIVITY_CONFIG } from '../activity/activity-config';
import { ActivityService } from '../activity/activity.service';
import { ActorResolver } from './actor-resolver';
import { WORKSPACE_CONFIG } from './workspace-config';
import { BETTER_AUTH, countUsers, createBetterAuth } from './better-auth.factory';
import { BetterAuthController } from './better-auth.controller';
import { resolveWorkspaceConfig } from './workspace-config';

describe('BetterAuthController', () => {
  let app: NestFastifyApplication;
  let storage: MemoryAdapter;

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    storage = new MemoryAdapter();
    await storage.initialize();
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController],
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
        ActivityService,
        ActorResolver,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await storage.close();
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
  let storage: MemoryAdapter;

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' });
    auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 'r'.repeat(40),
      config,
    });
    storage = new MemoryAdapter();
    await storage.initialize();
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController],
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
        ActivityService,
        ActorResolver,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await storage.close();
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

describe('BetterAuthController behind a TLS proxy', () => {
  let app: NestFastifyApplication;
  let storage: MemoryAdapter;

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ TRUST_PROXY: 'true' });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 'p'.repeat(40),
      config,
    });
    storage = new MemoryAdapter();
    await storage.initialize();
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController],
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
        ActivityService,
        ActorResolver,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ trustProxy: true }),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    await storage.close();
  });

  it('accepts the https origin the browser sends through the proxy', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      remoteAddress: '198.51.100.20',
      headers: {
        'content-type': 'application/json',
        host: 'monitor.internal',
        origin: 'https://monitor.example.com',
        'x-forwarded-host': 'monitor.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.9',
      },
      payload: { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('BetterAuthController activity events', () => {
  const EMAIL = 'owner@example.com';
  const PASSWORD = 'correct horse battery';
  const headers = { 'content-type': 'application/json', origin: 'http://localhost' };
  let app: NestFastifyApplication;
  let storage: MemoryAdapter;
  let sessionCookie: string;

  beforeAll(async () => {
    const config = resolveWorkspaceConfig({ AUTH_PUBLIC_URL: 'http://localhost' });
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: 's'.repeat(40),
      config,
    });
    storage = new MemoryAdapter();
    await storage.initialize();
    const moduleRef = await Test.createTestingModule({
      controllers: [BetterAuthController],
      providers: [
        { provide: BETTER_AUTH, useValue: auth },
        { provide: WORKSPACE_CONFIG, useValue: config },
        { provide: 'STORAGE_CLIENT', useValue: storage },
        { provide: ACTIVITY_CONFIG, useValue: { retentionDays: 90 } },
        ActivityService,
        ActorResolver,
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const signUp = await app.inject({
      method: 'POST',
      url: '/auth/sign-up/email',
      headers,
      payload: { email: EMAIL, password: PASSWORD, name: 'Owner' },
      remoteAddress: '198.51.100.31',
    });
    expect(signUp.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app.close();
    await storage.close();
  });

  async function logins(): Promise<Array<Record<string, unknown>>> {
    const page = await storage.getActivityRepository().list({ limit: 50, action: 'auth.login' });
    return page.items.map((item) => {
      return item.details;
    });
  }

  it('records the registration as auth.login with method register', async () => {
    expect(await logins()).toEqual([{ method: 'register' }]);
  });

  it('records nothing for a failed sign-in', async () => {
    const failed = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers,
      payload: { email: EMAIL, password: 'wrong password here' },
      remoteAddress: '198.51.100.32',
    });
    expect(failed.statusCode).toBe(401);
    expect(await logins()).toEqual([{ method: 'register' }]);
  });

  it('records auth.login for a successful sign-in', async () => {
    const ok = await app.inject({
      method: 'POST',
      url: '/auth/sign-in/email',
      headers,
      payload: { email: EMAIL, password: PASSWORD },
      remoteAddress: '198.51.100.33',
    });
    expect(ok.statusCode).toBe(200);
    sessionCookie = String(ok.headers['set-cookie']).split(';')[0];
    const page = await storage.getActivityRepository().list({ limit: 50, action: 'auth.login' });
    expect(page.items).toHaveLength(2);
    expect(page.items[0].actorEmail).toBe(EMAIL);
    expect(page.items[0].actorVia).toBe('session');
    expect(page.items[0].tokenId).toBeNull();
    expect(page.items[0].statusCode).toBe(200);
    expect(page.items[0].ip).toBe('198.51.100.33');
    expect(page.items[0].details).toEqual({ method: 'password' });
  });

  it('records auth.logout with the actor that signed out', async () => {
    const signOut = await app.inject({
      method: 'POST',
      url: '/auth/sign-out',
      headers: { ...headers, cookie: sessionCookie },
      payload: {},
      remoteAddress: '198.51.100.34',
    });
    expect(signOut.statusCode).toBe(200);
    const page = await storage.getActivityRepository().list({ limit: 50, action: 'auth.logout' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].actorEmail).toBe(EMAIL);
    expect(page.items[0].details).toEqual({});
  });
});
