import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BETTER_AUTH, BetterAuthInstance } from '../src/auth/better-auth.factory';
import { ROLE_REQUIRED_MESSAGE } from '../src/auth/guards/roles.guard';

const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };
const ADMIN = { email: 'admin@example.com', password: 'admin horse battery', name: 'Admin' };
const HEIR = { email: 'heir@example.com', password: 'heir horse battery', name: 'Heir' };
const TRUSTED_ORIGIN = 'http://localhost:5173';
const LOCAL_CREDENTIAL_ISSUER = 'local:credential';

const TOUCHED = [
  'WORKSPACE_DISABLED',
  'NODE_ENV',
  'BETTERDB_DATA_DIR',
  'AUTH_PUBLIC_URL',
  'AUTH_SECRET',
  'STORAGE_TYPE',
  'STORAGE_SQLITE_FILEPATH',
];

interface MeBody {
  userId: string;
  role: string;
  isOwner: boolean;
}

function extractAllCookies(setCookie: string | string[] | undefined): string {
  return ([] as string[])
    .concat(setCookie ?? [])
    .map((line) => {
      return line.split(';')[0];
    })
    .join('; ');
}

function jsonHeaders(cookie: string): Record<string, string> {
  return { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, cookie };
}

describe('Workspace session authority (E2E)', () => {
  let app: NestFastifyApplication;
  let ownerCookie: string;
  let adminCookie: string;
  let heirCookie: string;
  let adminId: string;
  let heirId: string;
  const previous = new Map<string, string | undefined>();
  const sqlitePath = join(tmpdir(), `workspace-session-authority-${Date.now()}.db`);

  async function me(cookie: string): Promise<{ statusCode: number; body: MeBody }> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/me',
      headers: { cookie },
    });
    return { statusCode: response.statusCode, body: response.json() as MeBody };
  }

  async function createMember(
    input: { email: string; password: string; name: string },
    role: 'admin' | 'member',
  ): Promise<void> {
    const auth = app.get<BetterAuthInstance>(BETTER_AUTH);
    const context = await auth.$context;
    const hashedPassword = await context.password.hash(input.password);
    const user = await context.internalAdapter.createUser(
      { email: input.email, name: input.name, emailVerified: false, role, isOwner: false },
      { method: 'email-password' } as never,
    );
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      issuer: LOCAL_CREDENTIAL_ISSUER,
      accountId: user.id,
      password: hashedPassword,
    });
  }

  async function signIn(
    input: { email: string; password: string },
    remoteAddress: string,
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: { email: input.email, password: input.password },
      remoteAddress,
    });
    if (response.statusCode !== 200) {
      throw new Error(`Sign-in failed: ${response.statusCode} ${response.body}`);
    }
    return extractAllCookies(response.headers['set-cookie']);
  }

  beforeAll(async () => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.AUTH_SECRET;
    process.env.NODE_ENV = 'production';
    process.env.BETTERDB_DATA_DIR = '';
    process.env.STORAGE_TYPE = 'sqlite';
    process.env.STORAGE_SQLITE_FILEPATH = sqlitePath;
    process.env.AUTH_PUBLIC_URL = TRUSTED_ORIGIN;

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

    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: TRUSTED_ORIGIN },
      payload: OWNER,
      remoteAddress: '198.51.100.41',
    });
    if (signUp.statusCode !== 200) {
      throw new Error(`Owner sign-up failed: ${signUp.statusCode} ${signUp.body}`);
    }
    ownerCookie = extractAllCookies(signUp.headers['set-cookie']);

    await createMember(ADMIN, 'admin');
    await createMember(HEIR, 'member');
    adminCookie = await signIn(ADMIN, '198.51.100.42');
    heirCookie = await signIn(HEIR, '198.51.100.43');

    adminId = (await me(adminCookie)).body.userId;
    heirId = (await me(heirCookie)).body.userId;
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
    rmSync(`${sqlitePath}-wal`, { force: true });
    rmSync(`${sqlitePath}-shm`, { force: true });
  });

  it('issues cookies that carry the cached session data', () => {
    expect(ownerCookie).toContain('session_data=');
    expect(adminCookie).toContain('session_data=');
    expect(heirCookie).toContain('session_data=');
  });

  it('stops admin access for a demoted admin reusing the original cookie', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/workspace/invitations',
      headers: { cookie: adminCookie },
    });
    expect(before.statusCode).toBe(200);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/workspace/members/${adminId}/role`,
      headers: jsonHeaders(ownerCookie),
      payload: { role: 'member' },
    });
    expect(demote.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/workspace/invitations',
      headers: { cookie: adminCookie },
    });
    expect(after.statusCode).toBe(403);
    expect(after.json()).toEqual(expect.objectContaining({ message: ROLE_REQUIRED_MESSAGE }));
    expect((await me(adminCookie)).body).toEqual(expect.objectContaining({ role: 'member' }));
  });

  it('stops owner access for a former owner reusing the original cookie', async () => {
    const transfer = await app.inject({
      method: 'POST',
      url: '/api/workspace/ownership/transfer',
      headers: jsonHeaders(ownerCookie),
      payload: { userId: heirId },
    });
    expect(transfer.statusCode).toBe(201);

    const formerOwnerRemoves = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/members/${adminId}`,
      headers: { cookie: ownerCookie },
    });
    expect(formerOwnerRemoves.statusCode).toBe(403);
    expect((await me(ownerCookie)).body).toEqual(expect.objectContaining({ isOwner: false }));
    expect((await me(heirCookie)).body).toEqual(
      expect.objectContaining({ role: 'admin', isOwner: true }),
    );
  });

  it('rejects a removed member reusing the original cookie', async () => {
    expect((await me(adminCookie)).statusCode).toBe(200);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/members/${adminId}`,
      headers: { cookie: heirCookie },
    });
    expect(remove.statusCode).toBe(200);

    expect((await me(adminCookie)).statusCode).toBe(401);
    const connections = await app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: { cookie: adminCookie },
    });
    expect(connections.statusCode).toBe(401);
  });
});
