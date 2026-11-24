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
if (!/read-only/i.test(body)) throw new Error(`SLOWLOG RESET failed for another reason: ${reset.status} ${body}`);
console.log(`mutation refused as expected: ${reset.status} ${body}`);
