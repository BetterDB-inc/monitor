// Phase injectors, run in-cluster as one-shot Jobs. Spec comes from INJECT (JSON).
// Every key carries the phase's hash tag, so all traffic lands on the target shard.
import { ClusterBatch } from '@valkey/valkey-glide';
import { z } from 'zod';
import type { SimConfig } from '../config.js';
import { clusterClient } from '../valkey.js';
import { intIn, rng } from './keys.js';

const Spec = z.discriminatedUnion('kind', [
  // Hot shard: read-modify on a small key set under one tag.
  z.object({ kind: z.literal('hot'), tag: z.string(), rps: z.number(), durationSec: z.number(), keys: z.number().int().positive() }),
  // Write flood with ever-new keys (memory pressure) or a bounded key set (replication burst).
  z.object({ kind: z.literal('write'), tag: z.string(), rps: z.number(), durationSec: z.number(), valueBytes: z.number().int().positive(), uniqueKeys: z.boolean(), keySpace: z.number().int().positive() }),
  // Build one large set, in batches.
  z.object({ kind: z.literal('bigSet'), key: z.string(), members: z.number().int().positive(), batch: z.number().int().positive() }),
  // O(N) reads of the large set, spread evenly over the duration.
  z.object({ kind: z.literal('smembers'), key: z.string(), calls: z.number().int().positive(), durationSec: z.number() }),
]);
export type InjectSpec = z.infer<typeof Spec>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function paced(rps: number, durationSec: number, op: (i: number) => Promise<unknown>) {
  const end = Date.now() + durationSec * 1000;
  let i = 0, errors = 0, ok = 0, carry = 0, last = performance.now();
  let secOk = 0, secErr = 0;
  const report = setInterval(() => {
    console.log(JSON.stringify({ ts: Date.now(), ok: secOk, errors: secErr }));
    secOk = secErr = 0;
  }, 1000);
  while (Date.now() < end) {
    const now = performance.now();
    carry += (rps * (now - last)) / 1000;
    last = now;
    for (; carry >= 1; carry--) op(i++).then(() => (ok++, secOk++), () => (errors++, secErr++));
    await sleep(5);
  }
  clearInterval(report);
  return { sent: i, ok, errors };
}

export async function inject(cfg: SimConfig) {
  const spec = Spec.parse(JSON.parse(process.env.INJECT ?? '{}'));
  const client = await clusterClient(cfg, cfg.clients.injectRequestTimeoutMs);
  const r = rng(cfg.seed);
  const t0 = Date.now();
  let result: unknown;
  switch (spec.kind) {
    case 'hot':
      result = await paced(spec.rps, spec.durationSec, (i) => {
        const k = `${spec.tag}:hot:${i % spec.keys}`;
        return i % 2 ? client.incr(k) : client.get(k);
      });
      break;
    case 'write': {
      const value = 'v'.repeat(spec.valueBytes);
      result = await paced(spec.rps, spec.durationSec, (i) =>
        client.set(`${spec.tag}:w:${spec.uniqueKeys ? `${t0}:${i}` : intIn(r, 0, spec.keySpace - 1)}`, value));
      break;
    }
    case 'bigSet': {
      await client.del([spec.key]);
      for (let i = 0; i < spec.members; i += spec.batch) {
        const b = new ClusterBatch(false);
        b.sadd(spec.key, Array.from({ length: Math.min(spec.batch, spec.members - i) }, (_, j) => `m${i + j}`));
        await client.exec(b, true);
      }
      result = { card: await client.scard(spec.key) };
      break;
    }
    case 'smembers': {
      const gap = (spec.durationSec * 1000) / spec.calls;
      const durations: number[] = [];
      for (let i = 0; i < spec.calls; i++) {
        const s = performance.now();
        await client.smembers(spec.key).catch(() => undefined);
        durations.push(performance.now() - s);
        await sleep(Math.max(0, gap - (performance.now() - s)));
      }
      result = { calls: spec.calls, clientMs: { min: Math.min(...durations), max: Math.max(...durations) } };
      break;
    }
  }
  console.log(JSON.stringify({ inject: spec.kind, startedAt: t0, endedAt: Date.now(), result }));
  client.close();
}
