// Drives the BetterDB plugin through OpenEverest's plugin proxy as the admin:
// turns monitoring on or off for an instance, or reads its status.
// Prints the status code on the first line and the body after it.
//
// usage: node scripts/e2e/plugin-action.mjs <base> <admin password> <namespace> <instance> <on|off|status> [--forged]
//   --forged sends "Bearer forged" instead of a real session, to check a refusal.
import process from 'node:process';

const [base, password, namespace, instance, action, flag] = process.argv.slice(2);
const routes = { on: ['POST', 'enable'], off: ['POST', 'disable'], status: ['GET', 'status'], 'settings-put': ['PUT', null] };
if (!base || !password || !namespace || !instance || !routes[action]) {
  throw new Error('usage: plugin-action.mjs <base> <password> <namespace> <instance> <on|off|status|settings-put> [--forged]');
}
const [method, segment] = routes[action];

let token = 'forged';
if (flag !== '--forged') {
  const login = await fetch(`${base}/v1/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'password', username: 'admin', password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  token = (await login.json()).access_token;
  if (!token) throw new Error('no access_token in the login response');
}

// Single cluster "main" in alpha.1; the proxy strips this prefix for the backend.
const plugin = '/v1/clusters/main/plugins/betterdb';
// settings-put tries to change the BetterDB URL and token; the backend must refuse (405).
const path = segment === null
  ? `${plugin}/api/settings`
  : `${plugin}/api/instances/main/${encodeURIComponent(namespace)}/${encodeURIComponent(instance)}/${segment}`;
const init = segment === null
  ? { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'wss://attacker.example/agent/ws', token: 'x' }) }
  : { method, headers: { Authorization: `Bearer ${token}` } };
const res = await fetch(`${base}${path}`, init);
console.log(res.status);
console.log(await res.text());
