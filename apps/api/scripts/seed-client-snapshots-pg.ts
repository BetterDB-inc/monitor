#!/usr/bin/env ts-node
/**
 * Load fixture: fill client_snapshots in PostgreSQL with millions of rows.
 *
 * Simulates the CLIENT LIST poller writing one batch per connection every
 * INTERVAL_MS with CLIENTS_PER_BATCH rows, walking backwards from now until
 * ROWS rows exist. Rows are inserted oldest-first in UNNEST batches so the
 * heap order matches a real deployment.
 *
 * Usage:
 *   STORAGE_URL=postgres://betterdb:devpassword@localhost:5440/betterdb \
 *   CONNECTION_IDS=env-default,<id2>,<id3>,<id4> ROWS=9600000 [END_AT_MS=<ms>] \
 *   npx ts-node scripts/seed-client-snapshots-pg.ts
 *
 * The schema must already exist (start the API once against the database).
 */
import { Pool } from 'pg';

const STORAGE_URL =
  process.env.STORAGE_URL || 'postgres://betterdb:devpassword@localhost:5440/betterdb';
const CONNECTION_IDS = (process.env.CONNECTION_IDS || 'env-default').split(',').map((s) => s.trim());
const ROWS = parseInt(process.env.ROWS || '9600000', 10);
const CLIENTS_PER_BATCH = parseInt(process.env.CLIENTS_PER_BATCH || '250', 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '60000', 10);
const UNNEST_ROWS = 5000;
// Optional: end the simulated history at this timestamp instead of now (set it to the
// oldest captured_at already present to extend an existing fixture further back).
const END_AT_MS = process.env.END_AT_MS ? parseInt(process.env.END_AT_MS, 10) : Date.now();

const NAMES = [
  'app-server-1', 'app-server-2', 'app-server-3', 'web-frontend-1', 'web-frontend-2',
  'cache-layer', 'worker-pool-1', 'worker-pool-2', 'monitoring-agent', 'backup-service',
  'analytics-worker', 'session-manager', 'rate-limiter', 'pubsub-handler', '',
];
const USERS = ['default', 'default', 'default', 'app', 'app', 'readonly', 'admin'];
const CMDS = ['get', 'set', 'hget', 'hset', 'client', 'ping', 'xreadgroup', 'eval', 'mget', 'zadd', 'NULL'];
const FLAGS = ['N', 'N', 'N', 'S', 'P', 'b'];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

interface Columns {
  client_id: string[]; addr: string[]; name: (string | null)[]; user_name: string[]; db: number[];
  cmd: (string | null)[]; age: number[]; idle: number[]; flags: string[]; sub: number[]; psub: number[];
  qbuf: number[]; qbuf_free: number[]; obl: number[]; oll: number[]; omem: number[];
  captured_at: number[]; source_host: string[]; source_port: number[]; connection_id: string[];
}

function emptyColumns(): Columns {
  return {
    client_id: [], addr: [], name: [], user_name: [], db: [], cmd: [], age: [], idle: [], flags: [],
    sub: [], psub: [], qbuf: [], qbuf_free: [], obl: [], oll: [], omem: [], captured_at: [],
    source_host: [], source_port: [], connection_id: [],
  };
}

const INSERT = `
  INSERT INTO client_snapshots (
    client_id, addr, name, user_name, db, cmd, age, idle, flags,
    sub, psub, qbuf, qbuf_free, obl, oll, omem,
    captured_at, source_host, source_port, connection_id
  )
  SELECT * FROM unnest(
    $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::int[], $8::int[], $9::text[],
    $10::int[], $11::int[], $12::int[], $13::int[], $14::int[], $15::int[], $16::int[],
    $17::bigint[], $18::text[], $19::int[], $20::text[]
  )`;

async function flush(pool: Pool, cols: Columns): Promise<void> {
  if (cols.client_id.length === 0) return;
  await pool.query(INSERT, [
    cols.client_id, cols.addr, cols.name, cols.user_name, cols.db, cols.cmd, cols.age, cols.idle,
    cols.flags, cols.sub, cols.psub, cols.qbuf, cols.qbuf_free, cols.obl, cols.oll, cols.omem,
    cols.captured_at, cols.source_host, cols.source_port, cols.connection_id,
  ]);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: STORAGE_URL, max: 4 });
  const rowsPerTick = CONNECTION_IDS.length * CLIENTS_PER_BATCH;
  const ticks = Math.ceil(ROWS / rowsPerTick);
  const now = END_AT_MS;
  const start = now - ticks * INTERVAL_MS;
  console.log(
    `Seeding ${ROWS} rows: ${CONNECTION_IDS.length} connections x ${CLIENTS_PER_BATCH} clients every ` +
      `${INTERVAL_MS}ms = ${ticks} batches per connection (${((ticks * INTERVAL_MS) / 86_400_000).toFixed(1)} days)`,
  );

  let cols = emptyColumns();
  let inserted = 0;
  let pending: Promise<void>[] = [];
  const startedAt = Date.now();

  for (let t = 0; t < ticks && inserted < ROWS; t++) {
    for (let c = 0; c < CONNECTION_IDS.length; c++) {
      // Each connection's poller fires at its own offset within the interval.
      const capturedAt = start + t * INTERVAL_MS + c * 1500 + (t % 7) * 10;
      const connId = CONNECTION_IDS[c];
      // Client population drifts slowly, with a daily peak.
      const dayPhase = ((capturedAt / 86_400_000) % 1) * Math.PI * 2;
      const count = Math.max(
        1,
        Math.round(CLIENTS_PER_BATCH * (0.85 + 0.15 * Math.sin(dayPhase)) + (t % 11) - 5),
      );
      for (let k = 0; k < count && inserted < ROWS; k++) {
        const host = `10.${c}.${k % 8}.${(k * 7) % 40 + 1}`;
        const port = 30000 + ((k * 131 + t) % 30000);
        const name = pick(NAMES, k * 3 + c);
        cols.client_id.push(String(100000 + k * 13 + c));
        cols.addr.push(`${host}:${port}`);
        cols.name.push(name === '' ? null : name);
        cols.user_name.push(pick(USERS, k + c));
        cols.db.push(0);
        const cmd = pick(CMDS, k + t);
        cols.cmd.push(cmd === 'NULL' ? null : cmd);
        cols.age.push((k * 97 + t * 60) % 864000);
        cols.idle.push((k * 31 + t) % 1200);
        cols.flags.push(pick(FLAGS, k));
        cols.sub.push(k % 50 === 0 ? 2 : 0);
        cols.psub.push(0);
        cols.qbuf.push(k % 97 === 0 ? 1_500_000 : (k * 17) % 26);
        cols.qbuf_free.push(k % 97 === 0 ? 0 : 20474);
        cols.obl.push(0);
        cols.oll.push(0);
        cols.omem.push(k % 211 === 0 ? 12_000_000 : 0);
        cols.captured_at.push(capturedAt);
        cols.source_host.push('localhost');
        cols.source_port.push(6400 + c + 1);
        cols.connection_id.push(connId);
        inserted++;
        if (cols.client_id.length >= UNNEST_ROWS) {
          pending.push(flush(pool, cols));
          cols = emptyColumns();
          if (pending.length >= 4) {
            await Promise.all(pending);
            pending = [];
          }
        }
      }
    }
    if (t % 1000 === 0 && t > 0) {
      const elapsed = (Date.now() - startedAt) / 1000;
      console.log(`  ${inserted} rows (${Math.round(inserted / elapsed)} rows/s)`);
    }
  }
  pending.push(flush(pool, cols));
  await Promise.all(pending);
  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`Done: ${inserted} rows in ${elapsed.toFixed(1)}s`);
  await pool.query('ANALYZE client_snapshots');
  const sizes = await pool.query(
    `SELECT pg_size_pretty(pg_total_relation_size('client_snapshots')) AS total,
            pg_size_pretty(pg_relation_size('client_snapshots')) AS heap`,
  );
  console.log(`client_snapshots size: heap ${sizes.rows[0].heap}, total with indexes ${sizes.rows[0].total}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
