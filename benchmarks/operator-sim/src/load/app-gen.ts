// Messaging-shaped steady load (GLIDE cluster client). Runs as a Deployment; total RPS is
// split across replicas. The target RPS is re-read every second from a file in an
// emptyDir that the scenario rewrites via `kubectl exec` (ConfigMap volumes lag ~60 s).
import { readFileSync } from 'node:fs';
import type { SimConfig } from '../config.js';
import { clusterClient } from '../valkey.js';
import { counterKey, datasetPlan, dedupKey, inboxKey, intIn, PROFILE_FIELDS, profileKey, rateLimitKey, rng } from './keys.js';

type Op = keyof SimConfig['load']['app']['mix'];

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

export async function appGen(cfg: SimConfig) {
  const a = cfg.load.app;
  const replicas = Number(process.env.APP_REPLICAS ?? a.replicas);
  const controlFile = process.env.CONTROL_FILE ?? a.controlFile;
  const readRps = () => {
    try {
      return Number(JSON.parse(readFileSync(controlFile, 'utf8')).rps) / replicas;
    } catch {
      return a.rps / replicas;
    }
  };
  const users = datasetPlan(cfg).users;
  const r = rng(cfg.seed ^ Number(process.env.POD_SEED ?? 0));
  const ops = Object.entries(a.mix) as [Op, number][];
  const pick = () => {
    let x = r();
    for (const [op, w] of ops) if ((x -= w) < 0) return op;
    return ops[ops.length - 1]![0];
  };

  const client = await clusterClient(cfg);
  process.on('SIGTERM', () => {
    client.close();
    process.exit(0);
  });
  const run: Record<Op, (uid: number) => Promise<unknown>> = {
    profileHGET: (uid) => client.hget(profileKey(uid), PROFILE_FIELDS[uid % PROFILE_FIELDS.length]!),
    counterINCR: (uid) => client.incr(counterKey(uid % datasetPlan(cfg).counters)),
    rateLimitINCRBY_EXPIRE: async (uid) => {
      const k = rateLimitKey(uid, Math.floor(Date.now() / 60_000));
      await client.incrBy(k, 1);
      return client.expire(k, a.rateLimitTtlSec);
    },
    dedupSADD_SISMEMBER: async (uid) => {
      const k = dedupKey(uid % datasetPlan(cfg).dedupSets);
      const m = `msg-${intIn(r, 0, a.dedupMemberSpace)}`;
      if (!(await client.sismember(k, m))) await client.sadd(k, [m]);
    },
    zsetZADD_ZRANGE: async (uid) => {
      const k = inboxKey(uid % datasetPlan(cfg).inboxes);
      await client.zadd(k, { [`msg-${Date.now()}-${intIn(r, 0, 1e6)}`]: Date.now() });
      await client.zremRangeByRank(k, 0, -(a.inboxKeep + 1));
      return client.zrange(k, { start: -10, end: -1 });
    },
  };

  let lat: number[] = [];
  let errors = 0;
  let sent = 0;
  let rps = readRps();
  let carry = 0;
  const tickMs = a.tickMs;

  setInterval(() => {
    const sorted = lat.sort((x, y) => x - y);
    console.log(JSON.stringify({ ts: Date.now(), pod: process.env.HOSTNAME, targetRps: Math.round(rps * replicas), ops: sorted.length, errors, p50: +quantile(sorted, 0.5).toFixed(3), p99: +quantile(sorted, 0.99).toFixed(3), sent }));
    lat = [];
    errors = 0;
    sent = 0;
    rps = readRps();
  }, 1000).unref();

  // Pace on elapsed time: setTimeout drift under host contention would otherwise under-deliver.
  let last = performance.now();
  for (;;) {
    const now = performance.now();
    carry += (rps * (now - last)) / 1000;
    last = now;
    const n = Math.floor(carry);
    carry -= n;
    for (let i = 0; i < n; i++) {
      const op = pick();
      const uid = intIn(r, 0, users - 1);
      const t0 = performance.now();
      sent++;
      run[op](uid).then(
        () => lat.push(performance.now() - t0),
        () => errors++,
      );
    }
    await new Promise((res) => setTimeout(res, tickMs));
  }
}
