import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.BETTERDB_TELEMETRY;
delete process.env.BETTERDB_MCP_TELEMETRY;
const telemetry = await import('../dist/telemetry.js');

const sent = [];
telemetry.initTelemetry(async (target, events) => {
  sent.push({ target, events });
});

const event = (toolName) => ({ toolName, success: true, durationMs: 1 });

test('events are flushed to the monitor they ran against', async () => {
  const a = { url: 'a', token: undefined, prefix: null };
  const b = { url: 'b', token: undefined, prefix: null };
  telemetry.trackToolCall(a, event('one'));
  telemetry.trackToolCall(b, event('two'));
  sent.length = 0;
  await telemetry.flushTelemetry(a);
  await telemetry.flushTelemetry(b);
  assert.deepEqual(
    sent.map(({ target, events }) => [target.url, events.map((e) => e.toolName)]),
    [['a', ['one']], ['b', ['two']]],
  );
});

test('a dropped target loses its buffer and ignores later events', async () => {
  const stopped = { url: 'stopped', token: undefined, prefix: null };
  telemetry.trackToolCall(stopped, event('before'));
  telemetry.dropTelemetry(stopped);
  telemetry.trackToolCall(stopped, event('after'));
  sent.length = 0;
  await telemetry.flushTelemetry(stopped);
  assert.deepEqual(sent, []);
});

test('isTelemetryDisabled accepts the off values in any case', () => {
  for (const value of ['false', '0', 'NO', ' Off ']) {
    assert.equal(telemetry.isTelemetryDisabled(value), true);
  }
  for (const value of [undefined, 'true', '1', '']) {
    assert.equal(telemetry.isTelemetryDisabled(value), false);
  }
});

test.after(() => telemetry.stopTelemetry());
