import type { SimConfig } from '../config.js';
import { type PodInfo, valkeyCli, valkeyPods } from '../infra/verify.js';
import { keySlot } from '../valkey.js';

export interface ShardView { shard: number; primary: PodInfo; replicas: PodInfo[]; slots: [number, number][] }

// Live topology from Valkey's own view (CLUSTER NODES), keyed by the operator's shard index.
// The operator shard index is a pod label and survives failovers; the primary pod does not.
export async function topology(cfg: SimConfig): Promise<Map<number, ShardView>> {
  const pods = (await valkeyPods(cfg)).filter((p) => p.phase === 'Running');
  const byIp = new Map(pods.map((p) => [p.ip, p]));
  // Any pod can be mid-restart during a roll or kill; ask the next one if it doesn't answer.
  let out: string | undefined;
  let lastErr: unknown;
  for (const p of pods) {
    try {
      out = await valkeyCli(cfg, p.name, ['cluster', 'nodes']);
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (out === undefined) throw lastErr ?? new Error('no running Valkey pod answered CLUSTER NODES');
  const rows = out.trim().split('\n').map((l) => l.split(' '));
  const view = new Map<number, ShardView>();
  for (const r of rows) {
    const flags = r[2]!;
    if (!flags.includes('master') || flags.includes('fail')) continue;
    const pod = byIp.get(r[1]!.split(':')[0]!);
    if (!pod) continue;
    const slots = r.slice(8).filter((s) => /^\d/.test(s)).map((s) => {
      const [a, b] = s.split('-').map(Number);
      return [a!, b ?? a!] as [number, number];
    });
    // A node can still list a demoted primary as `master` with no slots long after a
    // roll (gossip lag, FINDINGS). Only slot owners count as a shard's primary.
    if (slots.length === 0) continue;
    const replicas = rows.filter((x) => x[3] === r[0] && !x[2]!.includes('fail')).map((x) => byIp.get(x[1]!.split(':')[0]!)).filter((p): p is PodInfo => !!p);
    view.set(pod.shard, { shard: pod.shard, primary: pod, replicas, slots });
  }
  return view;
}

export const ownsSlot = (v: ShardView, slot: number) => v.slots.some(([a, b]) => slot >= a && slot <= b);

// A hash tag whose slot the shard owns. Uses `preferred` if it already lands there,
// otherwise the first `{<inner>:<n>}` that does (recorded as a note by the caller).
export function tagForShard(v: ShardView, preferred: string): { tag: string; slot: number; adjusted: boolean } {
  if (v.slots.length === 0) throw new Error(`shard ${v.shard} (${v.primary.name}) owns no slots`);
  const inner = preferred.replace(/^\{|\}$/g, '');
  const pslot = keySlot(preferred);
  if (ownsSlot(v, pslot)) return { tag: preferred, slot: pslot, adjusted: false };
  // A shard owns ≥ 1 slot, so this ends; the bound only guards against a bad slot map.
  for (let n = 0; n < 1_000_000; n++) {
    const tag = `{${inner}:${n}}`;
    const slot = keySlot(tag);
    if (ownsSlot(v, slot)) return { tag, slot, adjusted: true };
  }
  throw new Error(`no {${inner}:n} tag hashes into shard ${v.shard}`);
}
