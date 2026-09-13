import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };
const TRUSTED_ORIGIN = 'http://localhost:5173';
const OWNER_SIGN_UP_IP = '198.51.100.60';
const OWNER_SIGN_IN_IP = '198.51.100.61';

const TOUCHED = [
  'WORKSPACE_DISABLED',
  'NODE_ENV',
  'BETTERDB_DATA_DIR',
  'AUTH_PUBLIC_URL',
  'AUTH_SECRET',
  'STORAGE_TYPE',
  'STORAGE_SQLITE_FILEPATH',
  'ACTIVITY_RETENTION_DAYS',
];

interface ActivityItem {
  action: string;
  actor: { userId: string; email: string; via: string; tokenId: string | null };
  target: { type: string; id: string } | null;
}

interface ListedToken {
  id: string;
  userId: string | null;
  ownerEmail: string | null;
  lastUsedAt: number | null;
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const cookies = ([] as string[]).concat(setCookie ?? []).join('\n');
  const [first] = cookies.split(';');
  return first;
}

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', origin: TRUSTED_ORIGIN, ...extra };
}

describe('Workspace MCP tokens (E2E)', () => {
  let app: NestFastifyApplication;
  let ownerCookie: string;
  let ownerId: string;
  const previous = new Map<string, string | undefined>();
  const sqlitePath = join(tmpdir(), `workspace-mcp-tokens-${Date.now()}.db`);

  async function activity(): Promise<ActivityItem[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/workspace/activity',
      headers: { cookie: ownerCookie },
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: ActivityItem[] }).items;
  }

  beforeAll(async () => {
    for (const key of TOUCHED) {
      previous.set(key, process.env[key]);
    }
    delete process.env.WORKSPACE_DISABLED;
    delete process.env.AUTH_SECRET;
    delete process.env.ACTIVITY_RETENTION_DAYS;
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
      remoteAddress: OWNER_SIGN_UP_IP,
      headers: jsonHeaders(),
      payload: OWNER,
    });
    if (signUp.statusCode !== 200) {
      throw new Error(`Owner sign-up failed: ${signUp.statusCode} ${signUp.body}`);
    }
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: OWNER_SIGN_IN_IP,
      headers: jsonHeaders(),
      payload: { email: OWNER.email, password: OWNER.password },
    });
    ownerCookie = extractSessionCookie(signIn.headers['set-cookie']);
    const me = await app.inject({
      method: 'GET',
      url: '/api/workspace/me',
      headers: { cookie: ownerCookie },
    });
    ownerId = (me.json() as { userId: string }).userId;
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    rmSync(sqlitePath, { force: true });
    for (const key of TOUCHED) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('keeps MCP reads open without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/mcp/instances' });
    expect(response.statusCode).toBe(200);
  });

  it('attributes bearer calls to the token owner and stops a revoked token', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/agent-tokens',
      headers: jsonHeaders({ cookie: ownerCookie }),
      payload: { name: 'claude-code', type: 'mcp' },
    });
    expect(create.statusCode).toBe(201);
    const { token, id } = create.json() as { token: string; id: string };
    const bearer = { authorization: `Bearer ${token}` };

    const read = await app.inject({ method: 'GET', url: '/api/mcp/instances', headers: bearer });
    expect(read.statusCode).toBe(200);

    const update = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: jsonHeaders(bearer),
      payload: { auditPollIntervalMs: 12345 },
    });
    expect(update.statusCode).toBe(200);

    const invite = await app.inject({
      method: 'POST',
      url: '/api/workspace/invite',
      headers: jsonHeaders(bearer),
      payload: { email: 'token-invite@example.com', role: 'admin' },
    });
    expect(invite.statusCode).toBe(403);

    const updateEntry = (await activity()).find((item) => {
      return item.action === 'PUT /settings';
    });
    expect(updateEntry?.actor).toEqual({
      userId: ownerId,
      email: OWNER.email,
      via: 'token',
      tokenId: id,
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/agent-tokens',
      headers: { cookie: ownerCookie },
    });
    const listed = (list.json() as ListedToken[]).find((item) => {
      return item.id === id;
    });
    expect(listed).toEqual(
      expect.objectContaining({
        userId: ownerId,
        ownerEmail: OWNER.email,
        lastUsedAt: expect.any(Number),
      }),
    );

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/agent-tokens/${id}`,
      headers: { cookie: ownerCookie, origin: TRUSTED_ORIGIN },
    });
    expect(revoke.statusCode).toBe(200);

    const denied = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: jsonHeaders(bearer),
      payload: { auditPollIntervalMs: 23456 },
    });
    expect(denied.statusCode).toBe(401);

    const anonymousRead = await app.inject({
      method: 'GET',
      url: '/api/mcp/instances',
      headers: bearer,
    });
    expect(anonymousRead.statusCode).toBe(200);

    const tokenActions = (await activity())
      .filter((item) => {
        return item.target !== null && item.target.id === id;
      })
      .map((item) => {
        return item.action;
      });
    expect([...tokenActions].sort()).toEqual(['token.create', 'token.revoke']);
  });
});
