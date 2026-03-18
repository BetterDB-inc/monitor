#!/usr/bin/env ts-node
/**
 * Demo Data Seed Script (PostgreSQL)
 * Seeds slow log, latency, and memory snapshot data into PostgreSQL
 *
 * Usage: npx ts-node scripts/seed-demo-data-pg.ts
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const STORAGE_URL =
  process.env.STORAGE_URL ||
  `postgresql://${process.env.STORAGE_POSTGRES_USER || 'betterdb'}:${process.env.STORAGE_POSTGRES_PASSWORD || 'devpassword'}@${process.env.STORAGE_POSTGRES_HOST || 'localhost'}:${process.env.STORAGE_POSTGRES_PORT || '5432'}/${process.env.STORAGE_POSTGRES_DATABASE || 'betterdb'}`;

// Auto-detected at runtime from the most recently active connection
let CONNECTION_ID = process.env.CONNECTION_ID || 'env-default';
let SOURCE_HOST = process.env.SOURCE_HOST || 'localhost';
let SOURCE_PORT = parseInt(process.env.SOURCE_PORT || '6379', 10);

const NOW = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SEVEN_DAYS_AGO = NOW - 7 * DAY_MS;

// Helpers
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}
function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomSubset<T>(arr: T[], min: number, max: number): T[] {
  const count = randomInt(min, Math.min(max, arr.length));
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
function generateIP(): string {
  const subnets = ['192.168.1', '192.168.2', '10.0.0', '10.0.1', '172.16.0'];
  return `${randomChoice(subnets)}.${randomInt(1, 254)}`;
}

// Data
const CLIENT_NAMES = [
  'app-server-1', 'app-server-2', 'app-server-3',
  'web-frontend-1', 'web-frontend-2',
  'cache-layer', 'worker-pool-1', 'worker-pool-2',
  'monitoring-agent', 'backup-service', 'analytics-worker',
  'session-manager', 'rate-limiter', 'pubsub-handler',
];

const SLOW_COMMANDS: { cmd: string[]; baseDuration: number }[] = [
  { cmd: ['KEYS', '*'], baseDuration: 500_000 },
  { cmd: ['KEYS', 'user:*'], baseDuration: 300_000 },
  { cmd: ['SCAN', '0', 'COUNT', '1000000'], baseDuration: 200_000 },
  { cmd: ['SMEMBERS', 'large_set'], baseDuration: 150_000 },
  { cmd: ['HGETALL', 'big_hash'], baseDuration: 120_000 },
  { cmd: ['SORT', 'mylist'], baseDuration: 80_000 },
  { cmd: ['LRANGE', 'queue:tasks', '0', '-1'], baseDuration: 60_000 },
  { cmd: ['ZRANGEBYSCORE', 'leaderboard', '-inf', '+inf'], baseDuration: 45_000 },
  { cmd: ['SINTER', 'set1', 'set2', 'set3'], baseDuration: 40_000 },
  { cmd: ['MGET', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9', 'k10'], baseDuration: 25_000 },
  { cmd: ['GET', 'session:abc123'], baseDuration: 15_000 },
  { cmd: ['SET', 'cache:page:home', '<large_html>'], baseDuration: 12_000 },
  { cmd: ['XREAD', 'COUNT', '1000', 'STREAMS', 'events', '0'], baseDuration: 35_000 },
  { cmd: ['CLUSTER', 'INFO'], baseDuration: 18_000 },
  { cmd: ['DEBUG', 'SLEEP', '0.1'], baseDuration: 100_000 },
];

const LATENCY_EVENTS = [
  'command', 'fast-command', 'fork', 'aof-fsync-always',
  'aof-write', 'rdb-unlink-temp-file', 'expire-cycle',
  'eviction-cycle', 'active-defrag-cycle',
];

// ============================================================================
// SEED FUNCTIONS
// ============================================================================

async function seedSlowLog(pool: Pool): Promise<number> {
  console.log('Seeding Slow Log entries...');

  // Clear existing
  await pool.query('DELETE FROM slow_log_entries WHERE connection_id = $1', [CONNECTION_ID]);

  let total = 0;
  const BATCH = 100;
  let batch: any[][] = [];

  for (let i = 0; i < 300; i++) {
    const dayOffset = randomInt(0, 6);
    const hour = randomInt(0, 23);
    if (hour < 9 || hour > 18) {
      if (Math.random() < 0.6) continue;
    }

    const baseTs = SEVEN_DAYS_AGO + dayOffset * DAY_MS + hour * HOUR_MS + randomInt(0, HOUR_MS);
    const timestampSec = Math.floor(baseTs / 1000); // slow log timestamp in SECONDS
    const slow = randomChoice(SLOW_COMMANDS);
    const duration = Math.floor(slow.baseDuration * randomFloat(0.5, 2.5));
    const clientIP = generateIP();
    const clientPort = randomInt(40000, 65000);

    batch.push([
      1000 + i,                          // slowlog_id
      timestampSec,                      // timestamp (seconds)
      duration,                          // duration (microseconds)
      slow.cmd,                          // command (TEXT[] in pg)
      `${clientIP}:${clientPort}`,       // client_address
      randomChoice(CLIENT_NAMES),        // client_name
      baseTs,                            // captured_at (ms)
      SOURCE_HOST,
      SOURCE_PORT,
      CONNECTION_ID,
    ]);

    if (batch.length >= BATCH) {
      await insertSlowLogBatch(pool, batch);
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await insertSlowLogBatch(pool, batch);
    total += batch.length;
  }

  console.log(`  Created ${total} slow log entries`);
  return total;
}

async function insertSlowLogBatch(pool: Pool, rows: any[][]): Promise<void> {
  const placeholders: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const r of rows) {
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(...r);
  }

  await pool.query(
    `INSERT INTO slow_log_entries
      (slowlog_id, timestamp, duration, command, client_address, client_name, captured_at, source_host, source_port, connection_id)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (slowlog_id, source_host, source_port, connection_id) DO NOTHING`,
    values,
  );
}

async function seedCommandLog(pool: Pool): Promise<number> {
  console.log('Seeding Command Log entries (for Valkey COMMANDLOG)...');

  await pool.query(`DELETE FROM command_log_entries WHERE connection_id = $1 AND commandlog_id >= 100000`, [CONNECTION_ID]);

  let total = 0;
  const BATCH = 100;
  let batch: any[][] = [];

  for (let i = 0; i < 300; i++) {
    const dayOffset = randomInt(0, 6);
    const hour = randomInt(0, 23);
    if (hour < 9 || hour > 18) {
      if (Math.random() < 0.6) continue;
    }

    const baseTs = SEVEN_DAYS_AGO + dayOffset * DAY_MS + hour * HOUR_MS + randomInt(0, HOUR_MS);
    const timestampSec = Math.floor(baseTs / 1000);
    const slow = randomChoice(SLOW_COMMANDS);
    const duration = Math.floor(slow.baseDuration * randomFloat(0.5, 2.5));
    const clientIP = generateIP();
    const clientPort = randomInt(40000, 65000);

    batch.push([
      100000 + i,                        // commandlog_id
      timestampSec,                      // timestamp (seconds)
      duration,                          // duration (microseconds)
      slow.cmd,                          // command (TEXT[])
      `${clientIP}:${clientPort}`,       // client_address
      randomChoice(CLIENT_NAMES),        // client_name
      'slow',                            // log_type
      baseTs,                            // captured_at (ms)
      SOURCE_HOST,
      SOURCE_PORT,
      CONNECTION_ID,
    ]);

    if (batch.length >= BATCH) {
      await insertCommandLogBatch(pool, batch);
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await insertCommandLogBatch(pool, batch);
    total += batch.length;
  }

  console.log(`  Created ${total} command log entries`);
  return total;
}

async function insertCommandLogBatch(pool: Pool, rows: any[][]): Promise<void> {
  const placeholders: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const r of rows) {
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(...r);
  }

  await pool.query(
    `INSERT INTO command_log_entries
      (commandlog_id, timestamp, duration, command, client_address, client_name, log_type, captured_at, source_host, source_port, connection_id)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (commandlog_id, log_type, source_host, source_port, connection_id) DO NOTHING`,
    values,
  );
}

async function seedLatencySnapshots(pool: Pool): Promise<number> {
  console.log('Seeding Latency Snapshots...');

  await pool.query('DELETE FROM latency_snapshots WHERE connection_id = $1', [CONNECTION_ID]);

  let total = 0;
  const BATCH = 200;
  let batch: any[][] = [];

  for (let minOffset = 0; minOffset < 7 * 24 * 60; minOffset += 30) {
    const ts = SEVEN_DAYS_AGO + minOffset * MINUTE_MS;
    const activeEvents = randomSubset(LATENCY_EVENTS, 1, 4);

    for (const eventName of activeEvents) {
      let baseLatency: number;
      switch (eventName) {
        case 'fork':             baseLatency = randomInt(5_000, 50_000); break;
        case 'aof-fsync-always': baseLatency = randomInt(1_000, 20_000); break;
        case 'aof-write':        baseLatency = randomInt(500, 10_000); break;
        case 'expire-cycle':     baseLatency = randomInt(200, 5_000); break;
        case 'eviction-cycle':   baseLatency = randomInt(500, 8_000); break;
        case 'command':          baseLatency = randomInt(100, 3_000); break;
        case 'fast-command':     baseLatency = randomInt(50, 500); break;
        default:                 baseLatency = randomInt(100, 2_000);
      }
      if (Math.random() < 0.1) baseLatency = Math.floor(baseLatency * randomFloat(3, 10));

      const eventTs = Math.floor(ts / 1000); // LATENCY LATEST in seconds

      batch.push([
        randomUUID(),   // id
        ts,             // timestamp (ms)
        eventName,
        eventTs,        // latest_event_timestamp (seconds)
        baseLatency,    // max_latency (microseconds)
        CONNECTION_ID,
      ]);

      if (batch.length >= BATCH) {
        await insertLatencyBatch(pool, batch);
        total += batch.length;
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    await insertLatencyBatch(pool, batch);
    total += batch.length;
  }

  console.log(`  Created ${total} latency snapshots`);
  return total;
}

async function insertLatencyBatch(pool: Pool, rows: any[][]): Promise<void> {
  const placeholders: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const r of rows) {
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(...r);
  }

  await pool.query(
    `INSERT INTO latency_snapshots (id, timestamp, event_name, latest_event_timestamp, max_latency, connection_id)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
}

async function seedLatencyHistograms(pool: Pool): Promise<number> {
  console.log('Seeding Latency Histograms...');

  await pool.query('DELETE FROM latency_histograms WHERE connection_id = $1', [CONNECTION_ID]);

  const commandNames = ['GET', 'SET', 'HGET', 'HSET', 'LPUSH', 'RPOP', 'ZADD', 'ZRANGE', 'DEL', 'EXPIRE'];
  let total = 0;

  for (let hourOffset = 0; hourOffset < 7 * 24; hourOffset += 4) {
    const ts = SEVEN_DAYS_AGO + hourOffset * HOUR_MS;
    const data: Record<string, { calls: number; histogram: Record<string, number> }> = {};

    for (const cmd of commandNames) {
      const calls = randomInt(1000, 500_000);
      const histogram: Record<string, number> = {};
      const buckets = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
      let remaining = calls;

      for (let i = 0; i < buckets.length && remaining > 0; i++) {
        const fraction = i < 5 ? randomFloat(0.1, 0.35) : randomFloat(0.01, 0.1);
        const count = Math.min(Math.floor(calls * fraction), remaining);
        if (count > 0) {
          histogram[buckets[i].toString()] = count;
          remaining -= count;
        }
      }
      if (remaining > 0) histogram['1'] = (histogram['1'] || 0) + remaining;
      data[cmd] = { calls, histogram };
    }

    await pool.query(
      `INSERT INTO latency_histograms (id, timestamp, histogram_data, connection_id) VALUES ($1, $2, $3, $4)`,
      [randomUUID(), ts, JSON.stringify(data), CONNECTION_ID],
    );
    total++;
  }

  console.log(`  Created ${total} latency histograms`);
  return total;
}

async function seedMemorySnapshots(pool: Pool): Promise<number> {
  console.log('Seeding Memory Snapshots...');

  await pool.query('DELETE FROM memory_snapshots WHERE connection_id = $1', [CONNECTION_ID]);

  const maxmemory = 4_294_967_296;
  let usedMemory = randomInt(500_000_000, 1_000_000_000);
  let peakMemory = usedMemory;
  let cumulativeIoReads = 0;
  let cumulativeIoWrites = 0;

  let total = 0;
  const BATCH = 200;
  let batch: any[][] = [];

  for (let minOffset = 0; minOffset < 7 * 24 * 60; minOffset += 5) {
    const ts = SEVEN_DAYS_AGO + minOffset * MINUTE_MS;
    const hourOfDay = (minOffset / 60) % 24;
    const isBusinessHours = hourOfDay >= 8 && hourOfDay <= 20;
    const trafficMultiplier = isBusinessHours ? randomFloat(1.0, 1.5) : randomFloat(0.7, 1.0);

    usedMemory += Math.floor(randomFloat(-2_000_000, 5_000_000) * trafficMultiplier);
    usedMemory = Math.max(200_000_000, Math.min(usedMemory, 3_500_000_000));
    if (usedMemory > peakMemory) peakMemory = usedMemory;

    const rss = Math.floor(usedMemory * randomFloat(1.05, 1.3));
    const fragRatio = parseFloat((rss / usedMemory).toFixed(2));
    const allocFragRatio = parseFloat(randomFloat(1.0, 1.15).toFixed(2));
    const opsPerSec = Math.floor(randomInt(500, 5000) * trafficMultiplier);
    const cpuSys = parseFloat(randomFloat(0.5, 5.0).toFixed(3));
    const cpuUser = parseFloat(randomFloat(1.0, 15.0).toFixed(3));
    cumulativeIoReads += Math.floor(randomInt(10, 200) * trafficMultiplier);
    cumulativeIoWrites += Math.floor(randomInt(5, 100) * trafficMultiplier);

    batch.push([
      randomUUID(), ts, usedMemory, rss, peakMemory,
      fragRatio, maxmemory, allocFragRatio,
      opsPerSec, cpuSys, cpuUser,
      cumulativeIoReads, cumulativeIoWrites, CONNECTION_ID,
    ]);

    if (batch.length >= BATCH) {
      await insertMemoryBatch(pool, batch);
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await insertMemoryBatch(pool, batch);
    total += batch.length;
  }

  console.log(`  Created ${total} memory snapshots`);
  return total;
}

async function insertMemoryBatch(pool: Pool, rows: any[][]): Promise<void> {
  const placeholders: string[] = [];
  const values: any[] = [];
  let idx = 1;

  for (const r of rows) {
    placeholders.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`);
    values.push(...r);
  }

  await pool.query(
    `INSERT INTO memory_snapshots
      (id, timestamp, used_memory, used_memory_rss, used_memory_peak,
       mem_fragmentation_ratio, maxmemory, allocator_frag_ratio,
       ops_per_sec, cpu_sys, cpu_user,
       io_threaded_reads, io_threaded_writes, connection_id)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('BetterDB Monitor - PostgreSQL Demo Data Seeder');
  console.log('='.repeat(60));
  console.log(`Connecting to: ${STORAGE_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log();

  const pool = new Pool({ connectionString: STORAGE_URL });

  try {
    // Verify connection
    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL');

    // Auto-detect the most recently active connection ID and source info
    if (CONNECTION_ID === 'env-default') {
      const res = await pool.query(
        `SELECT connection_id, source_host, source_port FROM command_log_entries
         WHERE connection_id <> 'env-default'
         ORDER BY captured_at DESC LIMIT 1`
      );
      if (res.rows.length > 0) {
        CONNECTION_ID = res.rows[0].connection_id;
        SOURCE_HOST = res.rows[0].source_host || SOURCE_HOST;
        SOURCE_PORT = res.rows[0].source_port || SOURCE_PORT;
        console.log(`Auto-detected connection: ${CONNECTION_ID} (${SOURCE_HOST}:${SOURCE_PORT})`);
      }
    }
    console.log(`Using connection ID: ${CONNECTION_ID}`);
    console.log();

    const slowCount = await seedSlowLog(pool);
    const cmdLogCount = await seedCommandLog(pool);
    const latencyCount = await seedLatencySnapshots(pool);
    const histCount = await seedLatencyHistograms(pool);
    const memCount = await seedMemorySnapshots(pool);

    console.log();
    console.log('='.repeat(60));
    console.log('Done!');
    console.log('='.repeat(60));
    console.log();
    console.log(`  ${slowCount} slow log entries`);
    console.log(`  ${cmdLogCount} command log entries`);
    console.log(`  ${latencyCount} latency snapshots`);
    console.log(`  ${histCount} latency histograms`);
    console.log(`  ${memCount} memory snapshots`);
    console.log();
  } catch (err) {
    console.error('Error seeding data:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
