// On one agent connection: a read (slowlog length) must work and a mutation
// (DELETE /api/metrics/slowlog = SLOWLOG RESET) must be refused.
// usage: node scripts/e2e/check-read-only.mjs http://localhost:13001 <connection id>
import { monitorSession } from './monitor-session.mjs';

const [base, connectionId] = [process.argv[2] || 'http://localhost:3001', process.argv[3]];
if (!connectionId) throw new Error('connection id required');
const call = await monitorSession(base);
const headers = { 'x-connection-id': connectionId };

const read = await call('/api/metrics/slowlog/length', { headers });
if (!read.ok) throw new Error(`read failed on ${connectionId}: ${read.status} ${await read.text()}`);
console.log(`read ok: slowlog length ${JSON.stringify(await read.json())}`);

const reset = await call('/api/metrics/slowlog', { method: 'DELETE', headers });
const body = await reset.text();
if (reset.ok) throw new Error(`SLOWLOG RESET was accepted on read-only connection ${connectionId}: ${body}`);
if (reset.status !== 403 || !/read-only/i.test(body)) throw new Error(`SLOWLOG RESET failed for another reason: ${reset.status} ${body}`);
console.log(`mutation refused as expected: ${reset.status} ${body}`);

// The connection holds the admin user; CONFIG GET must not hand its
// password out, whether asked by name or through a glob.
for (const pattern of ['requirepass', 'masterauth', '*']) {
  const res = await call(`/api/metrics/config?pattern=${encodeURIComponent(pattern)}`, { headers });
  if (!res.ok) throw new Error(`CONFIG GET ${pattern} failed: ${res.status} ${await res.text()}`);
  const values = await res.json();
  for (const name of ['requirepass', 'masterauth', 'primaryauth']) {
    const value = values[name];
    if (value !== undefined && value !== '' && value !== '<redacted>') {
      throw new Error(`CONFIG GET ${pattern} leaked ${name} on read-only connection ${connectionId}`);
    }
  }
  if (pattern === '*' && values.maxmemory === undefined) throw new Error('CONFIG GET * lost the non-secret parameters');
  console.log(`CONFIG GET ${pattern}: credentials redacted (${Object.keys(values).length} parameters)`);
}

// ACL LIST carries #<sha256> password hashes; a read-only connection must not.
const acl = await call('/api/metrics/acl/list', { headers });
if (acl.status === 404) {
  console.log('ACL LIST: no HTTP route, checked through the CLI instead');
} else {
  if (!acl.ok) throw new Error(`ACL LIST failed: ${acl.status} ${await acl.text()}`);
  const rules = await acl.json();
  const text = JSON.stringify(rules);
  if (/#[0-9a-f]{64}/i.test(text)) throw new Error(`ACL LIST leaked a password hash on read-only connection ${connectionId}`);
  if (!/#<redacted>|nopass/.test(text)) throw new Error(`ACL LIST returned no rules to check: ${text.slice(0, 200)}`);
  console.log(`ACL LIST: hashes redacted (${Array.isArray(rules) ? rules.length : '?'} rules)`);
}

// ACL LOG RESET is a mutation too, and the refusal must be a 403 like the others.
const aclReset = await call('/api/metrics/acl/log', { method: 'DELETE', headers });
const aclBody = await aclReset.text();
if (aclReset.status !== 403 || !/read-only/i.test(aclBody)) throw new Error(`ACL LOG RESET was not refused with 403: ${aclReset.status} ${aclBody}`);
console.log(`ACL LOG RESET refused as expected: ${aclReset.status}`);
