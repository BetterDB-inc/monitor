// Mints an agent token on a self-hosted Monitor and prints it.
// usage: node scripts/e2e/mint-agent-token.mjs http://localhost:13001
import { monitorSession } from './monitor-session.mjs';

const call = await monitorSession(process.argv[2] || 'http://localhost:3001');
const res = await call('/api/agent-tokens', { method: 'POST', body: JSON.stringify({ name: 'openeverest-e2e', type: 'agent' }) });
if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
const { token } = await res.json();
process.stdout.write(token);
