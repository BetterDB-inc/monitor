import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadBetterSqlite3 } from '../storage/adapters/better-sqlite3-driver';
import { openLibsqlDatabase } from '../storage/adapters/libsql-driver';
import type { RawDatabaseHandle } from '../storage/raw-database-handle';
import { resolveWorkspaceConfig } from './workspace-config';
import {
  BetterAuthInstance,
  countUsers,
  createBetterAuth,
  runBetterAuthMigrations,
} from './better-auth.factory';

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
      headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip },
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
