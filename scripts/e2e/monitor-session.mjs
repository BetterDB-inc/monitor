// Shared by the OpenEverest e2e helpers: signs up the first (owner) account on
// a fresh self-hosted Monitor, or signs in when it already exists, and returns
// a fetch bound to that session's cookies.
//
// usage: import { monitorSession } from './monitor-session.mjs'

const EMAIL = process.env.E2E_MONITOR_EMAIL || 'e2e@betterdb.test';
const PASSWORD = process.env.E2E_MONITOR_PASSWORD || 'e2e-password-123';

export async function monitorSession(baseUrl) {
  const base = baseUrl.replace(/\/+$/, '');
  let cookie = '';
  const call = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(init.headers || {}) },
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length > 0) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    return res;
  };

  // An empty workspace lets the first sign-up in as owner; afterwards sign in.
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
