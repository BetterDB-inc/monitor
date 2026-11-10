import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'betterdb-mcp-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { PID_FILE, stopMonitor } = await import('../dist/autostart.js');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check) => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !check()) await new Promise((r) => setTimeout(r, 50));
};

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('stop_monitor leaves a reused PID alone', async () => {
  const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, `${stranger.pid}:3999`);
    const result = await stopMonitor();
    assert.equal(result.identified, true);
    assert.match(result.message, /not a running monitor/);
    assert.equal(alive(stranger.pid), true);
    assert.equal(fs.existsSync(PID_FILE), false);
  } finally {
    stranger.kill();
  }
});

test('stop_monitor kills the whole detached monitor group', { skip: process.platform === 'win32' }, async () => {
  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    console.log(child.pid);
    setTimeout(() => {}, 30000);
  `;
  const leader = spawn(process.execPath, ['-e', script, '@betterdb/monitor'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const grandchild = Number(await new Promise((resolve) => leader.stdout.once('data', resolve)));
  fs.writeFileSync(PID_FILE, `${leader.pid}:3999`);

  const result = await stopMonitor();
  assert.equal(result.stopped, true);
  assert.match(result.message, /Stopped monitor/);
  await waitFor(() => !alive(grandchild));
  assert.equal(alive(leader.pid), false);
  assert.equal(alive(grandchild), false);
});

test('start_monitor keeps the PID file when the old monitor does not stop', async () => {
  const { startMonitor } = await import('../dist/autostart.js');
  const stubborn = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)",
    '@betterdb/monitor',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, `${stubborn.pid}:39872`);
    await assert.rejects(
      startMonitor({ persist: true, port: 39872, storage: 'memory' }),
      /did not stop/,
    );
    assert.equal(alive(stubborn.pid), true);
    assert.equal(fs.readFileSync(PID_FILE, 'utf8'), `${stubborn.pid}:39872`);
  } finally {
    stubborn.kill('SIGKILL');
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
});

test('start_monitor does not spawn on a port used by something else', async () => {
  const { startMonitor } = await import('../dist/autostart.js');
  const http = await import('node:http');
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('ok');
    }).listen(0, () => resolve(s));
  });
  try {
    await assert.rejects(
      startMonitor({ persist: true, port: server.address().port, storage: 'memory' }),
      /not BetterDB/,
    );
    assert.equal(fs.existsSync(PID_FILE), false);
  } finally {
    server.close();
  }
});
