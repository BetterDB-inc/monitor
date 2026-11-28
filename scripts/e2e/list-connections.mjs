// Prints the Monitor's connection list as JSON (one connection per line).
// usage: node scripts/e2e/list-connections.mjs http://localhost:13001
import { monitorSession } from './monitor-session.mjs';

const call = await monitorSession(process.argv[2] || 'http://localhost:3001');
const res = await call('/api/connections');
if (!res.ok) throw new Error(`listing connections failed: ${res.status} ${await res.text()}`);
const body = await res.json();
const connections = Array.isArray(body) ? body : body.connections ?? [];
for (const connection of connections) process.stdout.write(`${JSON.stringify(connection)}\n`);
