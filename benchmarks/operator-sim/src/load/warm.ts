import { ClusterBatch, GlideClusterClient } from '@valkey/valkey-glide';
import type { SimConfig } from '../config.js';
import { clusterClient } from '../valkey.js';
import { counterKey, datasetPlan, dedupKey, inboxKey, intIn, profileKey, profileValue, projectedBytes, rng } from './keys.js';

const UNITS: Record<string, number> = { '': 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

// Valkey size notation ("256mb"); kb/mb/gb are powers of 1024.
export function parseBytes(s: string) {
  const m = /^(\d+)(kb|mb|gb)?$/i.exec(s);
  if (!m) throw new Error(`bad size ${s}`);
  return Number(m[1]) * UNITS[(m[2] ?? '').toLowerCase()]!;
}

// Preload the messaging dataset. Idempotent: skips when DBSIZE across primaries is
// already within `dataset.skipTolerance` of the planned key count.
export async function warm(cfg: SimConfig) {
  const plan = datasetPlan(cfg);
  const total = plan.users + plan.counters + plan.dedupSets + plan.inboxes;
  const capacity = cfg.cluster.shards * parseBytes(cfg.cluster.maxmemory);
  const projected = projectedBytes(cfg);
  console.log(JSON.stringify({ warm: { plan, total, projectedMB: Math.round(projected / 2 ** 20), capacityMB: Math.round(capacity / 2 ** 20) } }));
  if (projected > capacity * cfg.dataset.maxFillRatio)
    throw new Error(`projected ${Math.round(projected / 2 ** 20)}MB > ${cfg.dataset.maxFillRatio} × ${Math.round(capacity / 2 ** 20)}MB maxmemory; lower dataset.keys`);

  const client = await clusterClient(cfg, cfg.dataset.warmRequestTimeoutMs);
  const existing = Number(await client.dbsize({ route: 'allPrimaries' }));
  if (Math.abs(existing - total) <= total * cfg.dataset.skipTolerance) {
    console.log(JSON.stringify({ warm: { skipped: true, existing, total } }));
    client.close();
    return;
  }

  const r = rng(cfg.seed);
  const t0 = Date.now();
  let done = 0;
  const families: [number, (b: ClusterBatch, i: number) => void][] = [
    [plan.users, (b, i) => void b.hset(profileKey(i), profileValue(r, i, cfg))],
    [plan.counters, (b, i) => void b.set(counterKey(i), String(intIn(r, 0, 10_000)))],
    [plan.dedupSets, (b, i) => void b.sadd(dedupKey(i), Array.from({ length: cfg.dataset.setMembers }, (_, j) => `m${i}-${j}`.padEnd(cfg.dataset.memberBytes, '.')))],
    [plan.inboxes, (b, i) => void b.zadd(inboxKey(i), Object.fromEntries(Array.from({ length: cfg.dataset.setMembers }, (_, j) => [`msg${i}-${j}`.padEnd(cfg.dataset.memberBytes, '.'), 1_700_000_000 + j])))],
  ];
  for (const [count, add] of families) {
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < count; i += cfg.dataset.warmBatch) {
      const b = new ClusterBatch(false);
      for (let j = i; j < Math.min(count, i + cfg.dataset.warmBatch); j++) add(b, j);
      inflight.push((client as GlideClusterClient).exec(b, true));
      if (inflight.length >= cfg.dataset.warmConcurrency) await Promise.all(inflight.splice(0));
      done += Math.min(cfg.dataset.warmBatch, count - i);
      if (done % cfg.dataset.warmProgressEvery < cfg.dataset.warmBatch) console.log(JSON.stringify({ warm: { done, total, sec: (Date.now() - t0) / 1000 } }));
    }
    await Promise.all(inflight);
  }
  const after = Number(await client.dbsize({ route: 'allPrimaries' }));
  console.log(JSON.stringify({ warm: { done: true, dbsize: after, total, sec: (Date.now() - t0) / 1000 } }));
  client.close();
}
