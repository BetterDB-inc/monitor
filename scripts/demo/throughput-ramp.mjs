#!/usr/bin/env node

/**
 * Simulates a gradually increasing throughput load on Valkey for testing
 * the Throughput Forecasting feature.
 *
 * Usage:
 *   node scripts/demo/throughput-ramp.mjs [options]
 *
 * Options:
 *   --host         Valkey host (default: localhost)
 *   --port         Valkey port (default: 6380)
 *   --auth         Password (optional)
 *   --duration     Total duration in minutes (default: 60)
 *   --start-rps    Starting requests per second (default: 100)
 *   --end-rps      Ending requests per second (default: 5000)
 *   --pattern      Load pattern: ramp|spike|wave (default: ramp)
 *   --grow-keys    Write unique keys each tick so memory grows
 *   --value-size   Value size in bytes for --grow-keys (default: 1024)
 *   --cleanup      Remove generated keys on exit
 *
 * Patterns:
 *   ramp  - Linear increase from start-rps to end-rps over duration
 *   spike - Steady at start-rps, then sudden jump to end-rps at 75% of duration
 *   wave  - Oscillates between start-rps and end-rps with 10-minute period
 */

import { createConnection } from 'node:net';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    host: { type: 'string', default: 'localhost' },
    port: { type: 'string', default: '6380' },
    auth: { type: 'string', default: 'devpassword' },
    duration: { type: 'string', default: '60' },
    'start-rps': { type: 'string', default: '100' },
    'end-rps': { type: 'string', default: '5000' },
    pattern: { type: 'string', default: 'ramp' },
    'grow-keys': { type: 'boolean', default: false },
    'value-size': { type: 'string', default: '1024' },
    cleanup: { type: 'boolean', default: false },
  },
  strict: true,
});

const HOST = opts.host;
const PORT = parseInt(opts.port);
const AUTH = opts.auth;
const DURATION_MIN = parseInt(opts.duration);
const START_RPS = parseInt(opts['start-rps']);
const END_RPS = parseInt(opts['end-rps']);
const PATTERN = opts.pattern;
const GROW_KEYS = opts['grow-keys'];
const VALUE_SIZE = parseInt(opts['value-size']);
const CLEANUP = opts.cleanup;
const KEY_PREFIX = 'throughput_test';
const DURATION_MS = DURATION_MIN * 60_000;

let keyCounter = 0;
let valuePayload = '';
if (GROW_KEYS) {
  valuePayload = 'x'.repeat(VALUE_SIZE);
}

// --- RESP protocol helpers ---

function encodeCommand(...args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const s = String(arg);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

// --- Pattern functions ---

function getTargetRps(elapsedMs) {
  const progress = Math.min(elapsedMs / DURATION_MS, 1);

  switch (PATTERN) {
    case 'ramp':
      return Math.round(START_RPS + (END_RPS - START_RPS) * progress);
    case 'spike': {
      return progress < 0.75 ? START_RPS : END_RPS;
    }
    case 'wave': {
      const mid = (START_RPS + END_RPS) / 2;
      const amp = (END_RPS - START_RPS) / 2;
      const periodMs = 10 * 60_000;
      return Math.round(mid + amp * Math.sin((2 * Math.PI * elapsedMs) / periodMs));
    }
    default:
      return START_RPS;
  }
}

// --- Connection ---

function connect() {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: HOST, port: PORT }, () => resolve(sock));
    sock.on('error', reject);
  });
}

async function authenticate(sock) {
  if (!AUTH) return;
  return new Promise((resolve, reject) => {
    sock.once('data', (data) => {
      if (data.toString().startsWith('+OK')) resolve();
      else reject(new Error(`AUTH failed: ${data.toString().trim()}`));
    });
    sock.write(encodeCommand('AUTH', AUTH));
  });
}

async function ping(sock) {
  return new Promise((resolve, reject) => {
    sock.once('data', (data) => {
      if (data.toString().includes('PONG')) resolve();
      else reject(new Error(`PING failed: ${data.toString().trim()}`));
    });
    sock.write(encodeCommand('PING'));
  });
}

// --- Cleanup ---

async function cleanupKeys(sock) {
  if (!CLEANUP) return;
  process.stdout.write('\nCleaning up keys...');
  let cursor = '0';
  let deleted = 0;
  do {
    const resp = await new Promise((resolve) => {
      let buf = '';
      const onData = (data) => {
        buf += data.toString();
        // Wait for a complete SCAN response (heuristic: ends with \r\n after all elements)
        if (buf.split('\r\n').length > 3 && buf.endsWith('\r\n')) {
          sock.removeListener('data', onData);
          resolve(buf);
        }
      };
      sock.on('data', onData);
      sock.write(encodeCommand('SCAN', cursor, 'MATCH', `${KEY_PREFIX}_*`, 'COUNT', '1000'));
    });
    const lines = resp.split('\r\n').filter(Boolean);
    cursor = lines[1];
    const keys = lines.slice(3).filter((l) => !l.startsWith('*') && !l.startsWith('$'));
    if (keys.length > 0) {
      sock.write(encodeCommand('DEL', ...keys));
      deleted += keys.length;
      // Drain the DEL response
      await new Promise((resolve) => {
        sock.once('data', () => resolve());
      });
    }
  } while (cursor !== '0');
  console.log(` removed ${deleted} keys.`);
}

// --- Main ---

console.log('============================================');
console.log('  Throughput Ramp - Load Generator');
console.log('============================================');
console.log('');
console.log(`  Target:    ${HOST}:${PORT}`);
console.log(`  Pattern:   ${PATTERN}`);
console.log(`  Duration:  ${DURATION_MIN}m`);
console.log(`  Start RPS: ${START_RPS}`);
console.log(`  End RPS:   ${END_RPS}`);
console.log(`  Grow keys: ${GROW_KEYS}`);
if (GROW_KEYS) console.log(`  Value size: ${VALUE_SIZE}B`);
console.log(`  Cleanup:   ${CLEANUP}`);
console.log('');
console.log('  Press Ctrl+C to stop');
console.log('');

const sock = await connect();
await authenticate(sock);
await ping(sock);

// Switch socket to flowing mode, discard responses (fire-and-forget)
sock.resume();

const startTime = Date.now();
let opsThisSec = 0;
let lastSecond = Math.floor(Date.now() / 1000);
let tickTimer = null;
let done = false;

const TICK_MS = 10; // Fire every 10ms, batch commands per tick

function scheduleNext() {
  if (done) return;

  const elapsed = Date.now() - startTime;
  if (elapsed >= DURATION_MS) {
    finish();
    return;
  }

  const targetRps = getTargetRps(elapsed);
  const batchSize = Math.max(1, Math.round(targetRps * TICK_MS / 1000));

  // Send a batch of commands
  let buf = '';
  for (let i = 0; i < batchSize; i++) {
    if (GROW_KEYS) {
      const key = `${KEY_PREFIX}_${keyCounter++}`;
      buf += encodeCommand('SET', key, valuePayload);
    } else {
      buf += encodeCommand('PING');
    }
  }
  sock.write(buf);
  opsThisSec += batchSize;

  // Log progress once per second
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec !== lastSecond) {
    const elapsedMin = Math.floor(elapsed / 60_000);
    const remainingMin = Math.max(0, DURATION_MIN - elapsedMin);
    const pct = Math.min(100, Math.round((elapsed / DURATION_MS) * 100));
    const filled = Math.round((pct * 20) / 100);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled);

    process.stdout.write(
      `\r  ${bar} ${String(pct).padStart(3)}% | ` +
        `${String(elapsedMin).padStart(3)}m/${DURATION_MIN}m | ` +
        `${String(opsThisSec).padStart(5)} ops/sec | ${PATTERN} | ${remainingMin}m left `,
    );
    opsThisSec = 0;
    lastSecond = nowSec;
  }

  tickTimer = setTimeout(scheduleNext, TICK_MS);
}

function finish() {
  if (done) return;
  done = true;
  if (tickTimer) clearTimeout(tickTimer);

  const runtime = Math.round((Date.now() - startTime) / 1000);
  console.log('\n');
  console.log('Load generation complete.');
  console.log(`Total runtime: ${runtime}s`);

  (async () => {
    await cleanupKeys(sock);
    sock.end();
    process.exit(0);
  })();
}

process.on('SIGINT', finish);
process.on('SIGTERM', finish);

scheduleNext();
