import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimConfig } from '../config.js';
import { BetterdbApi } from '../betterdb/api.js';
import { clusterRoles, valkeyCli, valkeyPods } from '../infra/verify.js';
import { appGenLogs, appGenUp, memtierCollect, memtierStart } from './memtier.js';

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

async function primaryCommandTotals(cfg: SimConfig) {
  const pods = await valkeyPods(cfg);
  const roles = await clusterRoles(cfg, pods[0]!.name);
  const primaries = pods.filter((p) => roles.find((r) => r.ip === p.ip)?.role === 'primary');
  const totals = await Promise.all(primaries.map(async (p) => {
    const info = await valkeyCli(cfg, p.name, ['info', 'stats']);
    return [p.name, Number(/total_commands_processed:(\d+)/.exec(info)?.[1] ?? 0)] as const;
  }));
  return new Map(totals);
}

// Phase 4 acceptance: `steadySec` of app-gen + memtier, then check balance, errors,
// p99 stability, and log any BetterDB anomalies in the window as baseline FPs.
export async function steadyState(cfg: SimConfig, runDir: string) {
  const s = cfg.load.steady;
  mkdirSync(runDir, { recursive: true });
  await appGenUp(cfg);
  await memtierStart(cfg, s.durationSec + s.settleSec);
  console.log(`settling ${s.settleSec}s …`);
  await sleep(s.settleSec);
  const t0 = Date.now();
  const since = new Date(t0).toISOString();
  const before = await primaryCommandTotals(cfg);
  console.log(`steady window ${s.durationSec}s from ${since} …`);
  await sleep(s.durationSec);
  const after = await primaryCommandTotals(cfg);
  const t1 = Date.now();

  const rates = [...after].map(([pod, n]) => [pod, (n - (before.get(pod) ?? n)) / ((t1 - t0) / 1000)] as const);
  const mean = rates.reduce((a, [, r]) => a + r, 0) / rates.length;
  const worst = Math.max(...rates.map(([, r]) => Math.abs(r / mean - 1)));

  const lines = (await appGenLogs(cfg, since)).map((l) => JSON.parse(l)).filter((x) => x.ts >= t0 && x.ts <= t1);
  writeFileSync(join(runDir, 'appgen.jsonl'), lines.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const errors = lines.reduce((a, x) => a + x.errors, 0);
  const p99s = lines.map((x) => x.p99).sort((a, b) => a - b);
  const p99med = p99s[Math.floor(p99s.length / 2)] ?? 0;
  const p99hi = p99s[Math.floor(p99s.length * s.p99StabilityQuantile)] ?? 0;
  const clientOps = lines.reduce((a, x) => a + x.ops, 0) / ((t1 - t0) / 1000);

  const api = new BetterdbApi(cfg);
  const fps = await api.events(t0, t1).then((e) => ({ ok: true as const, events: e }), (e: Error) => ({ ok: false as const, error: e.message }));
  writeFileSync(join(runDir, 'steady-betterdb.json'), JSON.stringify(fps, null, 2));
  const memtierOk = await memtierCollect(cfg, join(runDir, 'memtier.json'));

  console.log('\nprimary            | cmds/s');
  for (const [pod, r] of rates.sort()) console.log(`${pod.padEnd(18)} | ${r.toFixed(0).padStart(6)}  (${((r / mean - 1) * 100).toFixed(1)}%)`);
  const checks: [string, boolean, string][] = [
    [`ops spread across ${cfg.cluster.shards} primaries within ±${s.balanceTolerance * 100}%`, rates.length === cfg.cluster.shards && worst <= s.balanceTolerance, `worst ${(worst * 100).toFixed(1)}%, mean ${mean.toFixed(0)} cmds/s`],
    ['zero client errors', errors === 0, `${errors} errors, ${clientOps.toFixed(0)} app ops/s over ${lines.length} pod-seconds`],
    [`client p99 stable (p${s.p99StabilityQuantile * 100} of per-second p99 ≤ ${s.p99StabilityFactor}× median)`, p99hi <= p99med * s.p99StabilityFactor, `median ${p99med}ms, p${s.p99StabilityQuantile * 100} ${p99hi}ms`],
    ['BetterDB: no anomalies in steady window', fps.ok && fps.events.length === 0, fps.ok ? `${fps.events.length} events (baseline FPs)` : `unavailable: ${fps.error.slice(0, 120)}`],
    ['memtier JSON collected', memtierOk, memtierOk ? 'memtier.json' : 'missing'],
  ];
  console.log('\ncheck                                                    | ok | detail');
  for (const [name, ok, detail] of checks) console.log(`${name.padEnd(56)} | ${ok ? '✔ ' : '✘ '} | ${detail}`);
  writeFileSync(join(runDir, 'steady.json'), JSON.stringify({ t0, t1, rates: Object.fromEntries(rates), checks }, null, 2));
  return checks;
}
