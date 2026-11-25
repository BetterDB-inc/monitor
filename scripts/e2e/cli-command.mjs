// Runs one command through the Monitor's CLI WebSocket (/api/cli/ws) on a
// connection, the way the in-browser CLI does, and prints the server's reply
// as JSON: {"type":"result","result":...} or {"type":"error","error":...}.
//
// usage: node scripts/e2e/cli-command.mjs <monitor base> <connection id> <command...>
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorCookie } from './monitor-session.mjs';

const [base, connectionId, ...words] = process.argv.slice(2);
if (!base || !connectionId || words.length === 0) throw new Error('usage: cli-command.mjs <base> <connection id> <command...>');

// The repo's ws package (Node's own WebSocket cannot send a Cookie header).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WebSocket = createRequire(join(repoRoot, 'apps/api/package.json'))('ws');

const cookie = await monitorCookie(base);
const url = `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/api/cli/ws`;
const ws = new WebSocket(url, { headers: { Cookie: cookie, Origin: base } });

const reply = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CLI reply timed out')), 30_000);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'execute', command: words.join(' '), connectionId })));
  ws.on('message', (data) => {
    clearTimeout(timer);
    resolve(JSON.parse(data.toString()));
  });
  ws.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
});
ws.close();
console.log(JSON.stringify(reply));
if (reply.type === 'error') process.exitCode = 2;
