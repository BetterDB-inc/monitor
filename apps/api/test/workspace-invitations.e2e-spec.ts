import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { READ_ONLY_MESSAGE } from '../src/auth/guards/mutation.guard';
import { ROLE_REQUIRED_MESSAGE } from '../src/auth/guards/roles.guard';

const OWNER = { email: 'owner@example.com', password: 'correct horse battery', name: 'Owner' };
const INVITEE = {
  email: 'Invitee@Example.com',
  name: 'Invitee',
  password: 'invitee horse battery',
};
const TRUSTED_ORIGIN = 'http://localhost:5173';

const TOUCHED = [
  'WORKSPACE_DISABLED',
  'NODE_ENV',
  'BETTERDB_DATA_DIR',
  'AUTH_PUBLIC_URL',
  'AUTH_SECRET',
  'STORAGE_TYPE',
  'STORAGE_SQLITE_FILEPATH',
];

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

describe('Workspace invitations (E2E)', () => {
  let app: NestFastifyApplication;
  let ownerCookie: string;
  let ownerId: string;
  let inviteToken: string;
  let invitationId: string;
  let inviteeCookie: string;
  let inviteeId: string;
  const previous = new Map<string, string | undefined>();
  const sqlitePath = join(tmpdir(), `workspace-invitations-${Date.now()}.db`);

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
      headers: jsonHeaders(),
      payload: OWNER,
    });
    if (signUp.statusCode !== 200) {
      throw new Error(`Owner sign-up failed: ${signUp.statusCode} ${signUp.body}`);
    }
    ownerCookie = extractSessionCookie(signUp.headers['set-cookie']);
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

  it('lets the owner create an invitation and returns the link once', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/workspace/invite',
      headers: jsonHeaders(ownerCookie),
      payload: { email: INVITEE.email, role: 'member' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; email: string; status: string; url: string };
    expect(body.email).toBe('invitee@example.com');
    expect(body.status).toBe('pending');
    expect(body.url.startsWith(`${TRUSTED_ORIGIN}/invite/`)).toBe(true);
    invitationId = body.id;
    inviteToken = body.url.slice(`${TRUSTED_ORIGIN}/invite/`.length);
    expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const list = await app.inject({
      method: 'GET',
      url: '/api/workspace/invitations',
      headers: { cookie: ownerCookie },
    });
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).not.toContain(inviteToken);
  });

  it('previews the invitation without a session', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/invite/${inviteToken}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      email: 'invitee@example.com',
      role: 'member',
      expired: false,
    });
  });

  it('accepts the invitation, creating a read-only member with a session', async () => {
    const accept = await app.inject({
      method: 'POST',
      url: `/api/invite/${inviteToken}/accept`,
      headers: jsonHeaders(),
      payload: { name: INVITEE.name, password: INVITEE.password },
    });
    expect(accept.statusCode).toBe(201);
    expect(accept.json()).toEqual(
      expect.objectContaining({ email: 'invitee@example.com', role: 'member', isOwner: false }),
    );
    inviteeCookie = extractSessionCookie(accept.headers['set-cookie']);
    expect(inviteeCookie).toContain('session_token=');

    const me = await app.inject({
      method: 'GET',
      url: '/api/workspace/me',
      headers: { cookie: inviteeCookie },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(
      expect.objectContaining({ email: 'invitee@example.com', role: 'member', isOwner: false }),
    );
    inviteeId = (me.json() as { userId: string }).userId;

    const mutation = await app.inject({
      method: 'POST',
      url: '/api/settings/reset',
      headers: jsonHeaders(inviteeCookie),
      payload: {},
    });
    expect(mutation.statusCode).toBe(403);
    expect(mutation.json()).toEqual(expect.objectContaining({ message: READ_ONLY_MESSAGE }));

    const again = await app.inject({
      method: 'POST',
      url: `/api/invite/${inviteToken}/accept`,
      headers: jsonHeaders(),
      payload: { name: INVITEE.name, password: INVITEE.password },
    });
    expect(again.statusCode).toBe(400);

    const list = await app.inject({
      method: 'GET',
      url: '/api/workspace/invitations',
      headers: { cookie: ownerCookie },
    });
    expect(list.json()).toEqual([
      expect.objectContaining({ id: invitationId, status: 'accepted' }),
    ]);
  });

  it('keeps public registration closed after the invite flow', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: jsonHeaders(),
      payload: { email: 'walkin@example.com', password: 'walkin horse battery', name: 'Walk-in' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets the member see the team but not manage it', async () => {
    const members = await app.inject({
      method: 'GET',
      url: '/api/workspace/members',
      headers: { cookie: inviteeCookie },
    });
    expect(members.statusCode).toBe(200);
    expect(members.json()).toHaveLength(2);

    const invitations = await app.inject({
      method: 'GET',
      url: '/api/workspace/invitations',
      headers: { cookie: inviteeCookie },
    });
    expect(invitations.statusCode).toBe(403);
    expect(invitations.json()).toEqual(expect.objectContaining({ message: ROLE_REQUIRED_MESSAGE }));

    const invite = await app.inject({
      method: 'POST',
      url: '/api/workspace/invite',
      headers: jsonHeaders(inviteeCookie),
      payload: { email: 'friend@example.com', role: 'admin' },
    });
    expect(invite.statusCode).toBe(403);
  });

  it('lets the owner promote, transfer ownership back and forth, and remove', async () => {
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/workspace/members/${inviteeId}/role`,
      headers: jsonHeaders(ownerCookie),
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json()).toEqual(expect.objectContaining({ id: inviteeId, role: 'admin' }));

    const transfer = await app.inject({
      method: 'POST',
      url: '/api/workspace/ownership/transfer',
      headers: jsonHeaders(ownerCookie),
      payload: { userId: inviteeId },
    });
    expect(transfer.statusCode).toBe(201);

    const formerOwnerRemoves = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/members/${inviteeId}`,
      headers: { cookie: ownerCookie },
    });
    expect(formerOwnerRemoves.statusCode).toBe(403);

    const transferBack = await app.inject({
      method: 'POST',
      url: '/api/workspace/ownership/transfer',
      headers: jsonHeaders(inviteeCookie),
      payload: { userId: ownerId },
    });
    expect(transferBack.statusCode).toBe(201);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/workspace/members/${inviteeId}`,
      headers: { cookie: ownerCookie },
    });
    expect(remove.statusCode).toBe(200);

    const gone = await app.inject({
      method: 'GET',
      url: '/api/workspace/me',
      headers: { cookie: inviteeCookie },
    });
    expect(gone.statusCode).toBe(401);

    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: jsonHeaders(),
      payload: { email: 'invitee@example.com', password: INVITEE.password },
    });
    expect(signIn.statusCode).toBe(401);
  });
});
