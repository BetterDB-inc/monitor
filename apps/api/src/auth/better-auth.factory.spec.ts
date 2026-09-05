import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadBetterSqlite3 } from '../storage/adapters/better-sqlite3-driver';
import { openLibsqlDatabase } from '../storage/adapters/libsql-driver';
import type { RawDatabaseHandle } from '../storage/raw-database-handle';
import { resolveWorkspaceConfig } from './workspace-config';
import {
  CLIENT_IP_HEADER,
  countUsers,
  createBetterAuth,
  runBetterAuthMigrations,
} from './better-auth.factory';
import type { BetterAuthInstance } from './better-auth.factory';

const SECRET = 's'.repeat(40);
const ORIGIN = 'http://localhost:3001';

function signUp(
  auth: BetterAuthInstance,
  email: string,
  ip: string,
  origin: string = ORIGIN,
): Promise<Response> {
  return auth.handler(
    new Request(`${ORIGIN}/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, [CLIENT_IP_HEADER]: ip },
      body: JSON.stringify({ email, password: 'correct horse battery', name: 'Someone' }),
    }),
  );
}

async function build(handle: RawDatabaseHandle): Promise<BetterAuthInstance> {
  const auth = await createBetterAuth({
    handle,
    secret: SECRET,
    config: resolveWorkspaceConfig({ AUTH_PUBLIC_URL: ORIGIN }),
  });
  await runBetterAuthMigrations(auth, handle);
  return auth;
}

async function signUpAt(publicOrigin: string | undefined, requestOrigin: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  if (publicOrigin !== undefined) {
    env.AUTH_PUBLIC_URL = publicOrigin;
  }
  const auth = await createBetterAuth({
    handle: { kind: 'memory' },
    secret: SECRET,
    config: resolveWorkspaceConfig(env),
  });
  const response = await auth.handler(
    new Request(`${requestOrigin}/auth/sign-up/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: requestOrigin,
        [CLIENT_IP_HEADER]: '10.2.0.1',
      },
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery',
        name: 'Someone',
      }),
    }),
  );
  expect(response.status).toBe(200);
  return response.headers.getSetCookie().join('\n');
}

describe('createBetterAuth', () => {
  it('makes the first sign-up an admin owner and closes sign-up afterwards (memory)', async () => {
    const auth = await build({ kind: 'memory' });
    expect(await countUsers(auth)).toBe(0);

    const first = await signUp(auth, 'owner@example.com', '10.0.0.1');
    expect(first.status).toBe(200);
    const cookie = first.headers.getSetCookie()[0].split(';')[0];
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(session?.user.role).toBe('admin');
    expect(session?.user.isOwner).toBe(true);
    expect(await countUsers(auth)).toBe(1);

    const second = await signUp(auth, 'second@example.com', '10.0.0.1');
    expect(second.status).toBe(403);
    expect(await countUsers(auth)).toBe(1);
  });

  it('leaves the session cookie insecure when no https public url is configured', async () => {
    const cookies = await signUpAt(undefined, 'http://localhost:5173');
    expect(cookies).toContain('better-auth.session_token');
    expect(cookies).not.toContain('__Secure-');
    expect(cookies).not.toContain('Secure');
  });

  it('marks the session cookie Secure for an https public url', async () => {
    const cookies = await signUpAt('https://monitor.example.com', 'https://monitor.example.com');
    expect(cookies).toContain('better-auth.session_token');
    expect(cookies).toContain('Secure');
  });

  it('accepts an https origin for the request host when no public url is configured', async () => {
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: SECRET,
      config: resolveWorkspaceConfig({ NODE_ENV: 'production' }),
    });
    const response = await auth.handler(
      new Request('http://monitor.example.com/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://monitor.example.com',
          cookie: 'seen=1',
          [CLIENT_IP_HEADER]: '10.3.0.1',
        },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: 'correct horse battery',
          name: 'Someone',
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it('still rejects a foreign origin when no public url is configured', async () => {
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: SECRET,
      config: resolveWorkspaceConfig({ NODE_ENV: 'production' }),
    });
    const response = await auth.handler(
      new Request('http://monitor.example.com/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example',
          cookie: 'seen=1',
          [CLIENT_IP_HEADER]: '10.3.0.2',
        },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: 'correct horse battery',
          name: 'Someone',
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('pins the origin to the public url when one is configured', async () => {
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: SECRET,
      config: resolveWorkspaceConfig({
        NODE_ENV: 'production',
        AUTH_PUBLIC_URL: 'https://monitor.example.com',
      }),
    });
    const response = await auth.handler(
      new Request('http://internal.local/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://internal.local',
          cookie: 'seen=1',
          [CLIENT_IP_HEADER]: '10.3.0.3',
        },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: 'correct horse battery',
          name: 'Someone',
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('derives the origin from the forwarded host when TRUST_PROXY is set', async () => {
    const auth = await createBetterAuth({
      handle: { kind: 'memory' },
      secret: SECRET,
      config: resolveWorkspaceConfig({ NODE_ENV: 'production', TRUST_PROXY: 'true' }),
    });
    const response = await auth.handler(
      new Request('http://internal.local/api/auth/sign-up/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://monitor.example.com',
          cookie: 'seen=1',
          'x-forwarded-host': 'monitor.example.com',
          'x-forwarded-proto': 'https',
          [CLIENT_IP_HEADER]: '10.3.0.4',
        },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: 'correct horse battery',
          name: 'Someone',
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it('caches the session in a signed cookie so reads skip the database', async () => {
    const cookies = await signUpAt(undefined, 'http://localhost:5173');
    expect(cookies).toContain('better-auth.session_data');
  });

  it('rejects an origin that is not trusted even under NODE_ENV=test', async () => {
    const auth = await build({ kind: 'memory' });
    const response = await signUp(auth, 'owner@example.com', '10.0.0.2', 'http://evil.example');
    expect(response.status).toBe(403);
  });

  it('accepts the vite dev origin outside production', async () => {
    const auth = await build({ kind: 'memory' });
    const response = await signUp(auth, 'owner@example.com', '10.0.0.3', 'http://localhost:5173');
    expect(response.status).toBe(200);
  });

  it('leaves a later sign-up creation unpromoted once the bootstrap slot is spent', async () => {
    const auth = await build({ kind: 'memory' });
    const first = await signUp(auth, 'owner@example.com', '10.0.0.6');
    expect(first.status).toBe(200);

    const promote = auth.options.databaseHooks.user.create.before;
    const context = await auth.$context;
    const endpointContext = { path: '/sign-up/email', context } as unknown as Parameters<
      typeof promote
    >[1];
    const candidate = {
      email: 'second@example.com',
      name: 'Second',
      emailVerified: false,
    } as unknown as Parameters<typeof promote>[0];

    const hooked = await promote(candidate, endpointContext);
    const created = await context.adapter.create({
      model: 'user',
      data: (hooked as { data: Record<string, unknown> }).data,
    });

    expect((created as { role: unknown }).role).toBe('member');
    expect((created as { isOwner: unknown }).isOwner).toBe(false);
  });

  it('runs migrations idempotently and round-trips on better-sqlite3', async () => {
    const path = join(tmpdir(), `factory-${Date.now()}-${Math.random()}.db`);
    const Database = await loadBetterSqlite3();
    const db = new Database(path);
    const handle: RawDatabaseHandle = { kind: 'sqlite', db };
    const auth = await build(handle);
    await runBetterAuthMigrations(auth, handle);
    const response = await signUp(auth, 'owner@example.com', '10.0.0.4');
    expect(response.status).toBe(200);
    const row = db.prepare('SELECT role, isOwner FROM user').get() as {
      role: string;
      isOwner: number;
    };
    expect(row.role).toBe('admin');
    expect(row.isOwner).toBe(1);
    db.close();
    unlinkSync(path);
  });

  it('round-trips on a libsql handle through the SqliteDialect wrapper', async () => {
    const path = join(tmpdir(), `factory-libsql-${Date.now()}-${Math.random()}.db`);
    const db = await openLibsqlDatabase({ url: `file:${path}` });
    const handle: RawDatabaseHandle = { kind: 'libsql', db };
    const auth = await build(handle);
    const response = await signUp(auth, 'owner@example.com', '10.0.0.5');
    expect(response.status).toBe(200);
    expect(await countUsers(auth)).toBe(1);
    db.close();
    unlinkSync(path);
  });
});
