// Shared by the OpenEverest e2e helpers: a signed-in fetch for a self-hosted
// Monitor. The first call signs up the owner account (an empty workspace lets
// the first sign-up in as owner) or signs in; the session cookies are kept in
// a file so the helpers, which run as separate processes in a loop, reuse one
// session instead of signing in each time and tripping better-auth's rate
// limit.
//
// usage: import { monitorSession } from './monitor-session.mjs'
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMAIL = process.env.E2E_MONITOR_EMAIL || 'e2e@betterdb.test';
const PASSWORD = process.env.E2E_MONITOR_PASSWORD || 'e2e-password-123';

export async function monitorSession(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  const jarFile = process.env.E2E_SESSION_FILE
    || join(tmpdir(), 'betterdb-e2e', `${createHash('sha256').update(base).digest('hex').slice(0, 12)}.json`);
  // Cookie jar by name: better-auth sets the session token at sign-in and a
  // separate session-data cookie on later responses, so each Set-Cookie must
  // merge into the jar rather than replace it.
  const jar = new Map(existsSync(jarFile) ? Object.entries(JSON.parse(readFileSync(jarFile, 'utf8'))) : []);
  const save = () => {
    mkdirSync(join(jarFile, '..'), { recursive: true });
    writeFileSync(jarFile, JSON.stringify(Object.fromEntries(jar)));
  };

  const call = async (path, init = {}) => {
    const cookie = Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');
    const res = await fetch(`${base}${path}`, {
      ...init,
      // better-auth refuses sign-in without an Origin it trusts; the Monitor's own is.
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Origin: base,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(init.headers || {}),
      },
    });
    for (const header of res.headers.getSetCookie?.() ?? []) {
      const [pair] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    save();
    return res;
  };
  call.cookieHeader = () => Array.from(jar, ([name, value]) => `${name}=${value}`).join('; ');

  if (jar.size > 0) {
    const session = await call('/api/auth/get-session');
    if (session.ok && (await session.text()).includes('"session"')) return call;
    jar.clear();
  }

  let res = await call('/api/auth/sign-up/email', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: 'e2e' }),
  });
  if (!res.ok) {
    res = await call('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  }
  if (!res.ok) throw new Error(`monitor sign-in failed: ${res.status} ${await res.text()}`);
  return call;
}

/** The session's Cookie header, for a WebSocket upgrade (the CLI) that cannot go through fetch. */
export async function monitorCookie(baseUrl) {
  const call = await monitorSession(baseUrl);
  // A round trip refreshes the jar; the cookie is what call() would send next.
  await call('/api/auth/get-session');
  return call.cookieHeader();
}
