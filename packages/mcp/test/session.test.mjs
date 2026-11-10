import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MonitorSession, isSameMonitor } from '../dist/session.js';

const cloud = {
  BETTERDB_URL: 'https://acme.app.betterdb.com',
  BETTERDB_TOKEN: 'cloud-token',
  BETTERDB_LOCAL_TOKEN: 'local-token',
  BETTERDB_INSTANCE_ID: 'inst-1',
};

test('loopback hosts on the same port are the same monitor', () => {
  assert.equal(isSameMonitor('http://localhost:3001', 'http://127.0.0.1:3001'), true);
  assert.equal(isSameMonitor('http://localhost:3001', 'http://[::1]:3001/'), true);
  assert.equal(isSameMonitor('http://localhost:3001', 'http://localhost:3002'), false);
  assert.equal(isSameMonitor('https://a.example.com', 'https://a.example.com:443'), true);
  assert.equal(isSameMonitor('not a url', 'not a url'), false);
});

test('without BETTERDB_URL the local monitor gets the token and instance', () => {
  const session = new MonitorSession({ BETTERDB_TOKEN: 't', BETTERDB_INSTANCE_ID: 'i' });
  assert.deepEqual(session.target, { url: 'http://localhost:3001', token: 't', prefix: null });
  assert.equal(session.instanceId, 'i');
  session.switchTo('http://127.0.0.1:3001', true);
  assert.equal(session.target.token, 't');
  assert.equal(session.restoreAfterStop(), null);
});

test('a different local monitor never gets the cloud token or instance', () => {
  const session = new MonitorSession(cloud);
  assert.equal(session.target.token, 'cloud-token');
  session.switchTo('http://localhost:3001', true);
  assert.equal(session.target.token, 'local-token');
  assert.equal(session.instanceId, null);
});

test('stop restores the remembered monitor, token and instance', () => {
  const session = new MonitorSession(cloud);
  const original = session.target;
  session.switchTo('http://localhost:3001', true);
  const local = session.target;
  assert.equal(session.restoreAfterStop(), local);
  assert.equal(session.target, original);
  assert.equal(session.instanceId, 'inst-1');
  assert.equal(session.restoreAfterStop(), null);
});

test('switching without remembering leaves nothing to restore', () => {
  const session = new MonitorSession(cloud);
  session.switchTo('http://localhost:3001', false);
  assert.equal(session.restoreAfterStop(), null);
  assert.equal(session.target.url, 'http://localhost:3001');
});

test('a second switch keeps the first remembered monitor', () => {
  const session = new MonitorSession(cloud);
  session.switchTo('http://localhost:3001', true);
  session.switchTo('http://localhost:4001', true);
  session.restoreAfterStop();
  assert.equal(session.target.url, 'https://acme.app.betterdb.com');
});
