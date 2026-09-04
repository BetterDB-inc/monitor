import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { INVALID_CURSOR_MESSAGE } from '../src/activity/activity.service';

const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };
const INVITEE = {
  email: 'invitee@example.com',
  name: 'Invitee',
  password: 'invitee horse battery',
};
const TRUSTED_ORIGIN = 'http://localhost:5173';
const OWNER_SIGN_UP_IP = '198.51.100.50';
const OWNER_SIGN_IN_IP = '198.51.100.51';

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
  id: string;
  occurredAt: string;
  actor: { userId: string; email: string; via: string; tokenId: string | null };
  action: string;
  target: { type: string; id: string } | null;
  connectionId: string | null;
  statusCode: number;
  details: Record<string, unknown>;
}

interface ActivityPageBody {
  items: ActivityItem[];
  nextCursor: string | null;
}

function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const cookies = ([] as string[]).concat(setCookie ?? []).join('\n');
  const [first] = cookies.split(';');
  return first;
}

function jsonHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: TRUSTED_ORIGIN,
  };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return headers;
}

describe('Workspace activity log (E2E)', () => {
  let app: NestFastifyApplication;
  let ownerCookie: string;
  let ownerId: string;
  let inviteeCookie: string;
  let inviteeId: string;
  let invitationId: string;
  const previous = new Map<string, string | undefined>();
  const sqlitePath = join(tmpdir(), `workspace-activity-${Date.now()}.db`);

  async function activity(cookie: string, query = ''): Promise<ActivityPageBody> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/workspace/activity${query}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as ActivityPageBody;
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

  it('records the owner registration and sign-in', async () => {
    const page = await activity(ownerCookie);
    const actions = page.items.map((item) => {
      return item.action;
    });
    expect(actions).toEqual(['auth.login', 'auth.login']);
    const methods = page.items.map((item) => {
      return item.details.method;
    });
    expect([...methods].sort()).toEqual(['password', 'register']);
    for (const item of page.items) {
      expect(item.actor).toEqual({
        userId: ownerId,
        email: OWNER.email,
        via: 'session',
        tokenId: null,
      });
    }
  });

  it('records an invitation with its id as the target', async () => {
    const invite = await app.inject({
      method: 'POST',
      url: '/api/workspace/invite',
      headers: jsonHeaders(ownerCookie),
      payload: { email: INVITEE.email, role: 'member' },
    });
    expect(invite.statusCode).toBe(201);
    const body = invite.json() as { id: string; url: string };
    invitationId = body.id;
    const token = body.url.split('/invite/')[1];

    const accept = await app.inject({
      method: 'POST',
      url: `/api/invite/${token}/accept`,
      headers: jsonHeaders(),
      payload: { name: INVITEE.name, password: INVITEE.password },
    });
    expect(accept.statusCode).toBe(201);
    inviteeCookie = extractSessionCookie(accept.headers['set-cookie']);
    inviteeId = (accept.json() as { userId: string }).userId;

    const page = await activity(ownerCookie);
    const actions = page.items.map((item) => {
      return item.action;
    });
    expect(actions).toEqual(['auth.login', 'member.invite', 'auth.login', 'auth.login']);
    const [inviteLogin, memberInvite] = page.items;
    expect(inviteLogin.actor.userId).toBe(inviteeId);
    expect(inviteLogin.details).toEqual({ method: 'invite' });
    expect(memberInvite.statusCode).toBe(201);
    expect(memberInvite.target).toEqual({ type: 'invitation', id: invitationId });
    expect(memberInvite.details).toEqual({ method: 'POST', path: '/workspace/invite' });
    expect(memberInvite.connectionId).toBeNull();
  });

  it('does not record requests the guards refuse', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/workspace/invite',
      headers: jsonHeaders(inviteeCookie),
      payload: { email: 'other@example.com', role: 'member' },
    });
    expect(denied.statusCode).toBe(403);
    const listing = await app.inject({
      method: 'GET',
      url: '/api/workspace/activity',
      headers: { cookie: inviteeCookie },
    });
    expect(listing.statusCode).toBe(403);
    const page = await activity(ownerCookie, `?actor=${encodeURIComponent(inviteeId)}`);
    const actions = page.items.map((item) => {
      return item.action;
    });
    expect(actions).toEqual(['auth.login']);
  });

  it('records a role change against the member', async () => {
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/workspace/members/${inviteeId}/role`,
      headers: jsonHeaders(ownerCookie),
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);
    const page = await activity(ownerCookie, '?action=member.role');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].target).toEqual({ type: 'member', id: inviteeId });
    expect(page.items[0].statusCode).toBe(200);
  });

  it('pages through the log with the cursor and validates it', async () => {
    const all = await activity(ownerCookie);
    const first = await activity(ownerCookie, '?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await activity(
      ownerCookie,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );
    const seen = [...first.items, ...second.items].map((item) => {
      return item.id;
    });
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(
      all.items.slice(0, seen.length).map((item) => {
        return item.id;
      }),
    );
    const bad = await app.inject({
      method: 'GET',
      url: '/api/workspace/activity?cursor=%21%21',
      headers: { cookie: ownerCookie },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { message: string }).message).toBe(INVALID_CURSOR_MESSAGE);
  });

  it('filters by an inclusive time window', async () => {
    const all = await activity(ownerCookie);
    const newest = all.items[0].occurredAt;
    const oldest = all.items[all.items.length - 1].occurredAt;
    const window = await activity(
      ownerCookie,
      `?from=${encodeURIComponent(oldest)}&to=${encodeURIComponent(newest)}`,
    );
    expect(window.items).toHaveLength(all.items.length);
    const future = new Date(Date.parse(newest) + 60_000).toISOString();
    const none = await activity(ownerCookie, `?from=${encodeURIComponent(future)}`);
    expect(none.items).toEqual([]);
  });

  it('records the sign-out with the actor that signed out', async () => {
    const signOut = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: jsonHeaders(inviteeCookie),
      payload: {},
    });
    expect(signOut.statusCode).toBe(200);
    const page = await activity(ownerCookie, '?action=auth.logout');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].actor.userId).toBe(inviteeId);
    const everything = await activity(ownerCookie);
    for (const item of everything.items) {
      expect(item.action.startsWith('POST /auth')).toBe(false);
    }
  });
});
