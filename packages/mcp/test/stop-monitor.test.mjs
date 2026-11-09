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
