import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { identifyProcess, isBetterDbMonitor, monitorEnv } from '../dist/autostart.js';

test('monitorEnv drops MCP variables in any case and applies overrides last', () => {
  const env = monitorEnv(
    {
      Path: '/bin',
      betterdb_token: 'secret',
      BETTERDB_URL: 'https://cloud',
      BetterDB_Local_Token: 'x',
      BETTERDB_INSTANCE_ID: 'i',
      BETTERDB_MCP_TELEMETRY: 'false',
      node_env: 'development',
      BETTERDB_MONITOR_LOG_LEVEL: 'debug',
      BETTERDB_MONITOR_node_env: 'test',
      BETTERDB_MONITOR_port: '9999',
      betterdb_monitor_STORAGE_TYPE: 'postgres',
    },
    { PORT: '3001', STORAGE_TYPE: 'memory', NODE_ENV: 'production' },
  );
  assert.deepEqual(env, {
    Path: '/bin',
    PORT: '3001',
    STORAGE_TYPE: 'memory',
    LOG_LEVEL: 'debug',
    node_env: 'test',
  });
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, () => resolve(server));
  });
}

test('a port that answers everything with HTML is not a BetterDB monitor', async () => {
  const server = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html></html>');
  });
  try {
    assert.equal(await isBetterDbMonitor(server.address().port), false);
  } finally {
    server.close();
  }
});

test('JSON from /api/mcp/instances or /mcp/instances identifies a monitor', async () => {
  for (const prefix of ['/api', '']) {
    const server = await listen((req, res) => {
      const ok = req.url === `${prefix}/mcp/instances`;
      res.writeHead(ok ? 200 : 404, { 'content-type': ok ? 'application/json' : 'text/html' });
      res.end(ok ? '[]' : 'no');
    });
    try {
      assert.equal(await isBetterDbMonitor(server.address().port), true, `prefix ${prefix || "''"}`);
    } finally {
      server.close();
    }
  }
});

test('a closed port is not a BetterDB monitor', async () => {
  const server = await listen(() => {});
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isBetterDbMonitor(port), false);
});

test('identifyProcess matches only processes running the monitor package', { skip: process.platform === 'win32' }, async () => {
  const monitor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '@betterdb/monitor']);
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(identifyProcess(monitor.pid), 'monitor');
    assert.equal(identifyProcess(other.pid), 'other');
  } finally {
    monitor.kill();
    other.kill();
  }
  await new Promise((resolve) => monitor.once('exit', resolve));
  assert.equal(identifyProcess(monitor.pid), 'other');
});
