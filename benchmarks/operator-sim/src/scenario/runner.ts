import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import type { PhaseName, SimConfig } from '../config.js';
import { startBetterdbCollector } from '../betterdb/collector.js';
import { Screenshots } from '../betterdb/screenshots.js';
import { waitClusterReady } from '../infra/valkey.js';
import { valkeyCli } from '../infra/verify.js';
import { kubectlJson } from '../k8s.js';
import { appGenLogs, appGenUp, memtierCollect, memtierStart, setAppRps } from '../load/memtier.js';
import { truthCollect, truthStart, truthStop } from '../truth/deploy.js';
import type { Injected, Phase, PhaseCtx, ScenarioEvent } from './phase.js';
import { hotShard } from './phases/hotShard.js';
import { memoryPressure } from './phases/memoryPressure.js';
import { primaryKill } from './phases/primaryKill.js';
import { replicaLag } from './phases/replicaLag.js';
import { rollingUpdate } from './phases/rollingUpdate.js';
import { slowCommands } from './phases/slowCommands.js';
import { spike } from './phases/spike.js';
import { topology } from './topology.js';

const PHASES: Record<PhaseName, Phase> = { spike, hotShard, slowCommands, memoryPressure, replicaLag, primaryKill, rollingUpdate };
const ROOT = new URL('../..', import.meta.url).pathname;
const NO_EXPECT = { patterns: [], metrics: [], nodes: [] };

export function selectedPhases(cfg: SimConfig, only = process.env.PHASES): Phase[] {
  const names = only ? only.split(',').map((s) => s.trim()) : cfg.scenario.phases;
  for (const n of names) if (!(n in PHASES)) throw new Error(`unknown phase ${n}; known: ${Object.keys(PHASES).join(',')}`);
  return names.filter((n) => n !== 'rollingUpdate' || cfg.scenario.rollingUpdate.enabled).map((n) => PHASES[n as PhaseName]);
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function timeline(cfg: SimConfig, phases: Phase[]) {
  const rows: { at: number; what: string; sec: number }[] = [{ at: 0, what: 'baseline', sec: cfg.scenario.baselineSec }];
  let t = cfg.scenario.baselineSec;
  for (const p of phases) {
    rows.push({ at: t, what: `${p.name} — ${p.summary(cfg)}`, sec: p.plannedSec(cfg) });
    t += p.plannedSec(cfg);
    rows.push({ at: t, what: 'gap (recovery)', sec: cfg.scenario.gapSec });
    t += cfg.scenario.gapSec;
  }
  return { rows, totalSec: t };
}

function banner(text: string) {
  const line = '═'.repeat(Math.max(60, text.length + 8));
  console.log(`\n\x1b[1;97;44m${line}\n    ${text.padEnd(line.length - 4)}\n${line}\x1b[0m`);
}

export async function runScenario(cfg: SimConfig) {
  const phases = selectedPhases(cfg);
  const plan = timeline(cfg, phases);
  if (process.env.DRY_RUN === '1') {
    banner(`DRY RUN — ${phases.length} phases, ~${fmt(plan.totalSec)} (seed ${cfg.seed})`);
    for (const r of plan.rows) console.log(`  T+${fmt(r.at).padStart(6)}  ${String(r.sec).padStart(5)}s  ${r.what}`);
    return;
  }

  const runStart = Date.now();
  const runId = process.env.RUN_ID ?? `${new Date(runStart).toISOString().replace(/[:.]/g, '-').replace('Z', '')}-s${cfg.seed}`;
  const runDir = join(ROOT, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const eventsFile = join(runDir, 'events.jsonl');
  let seq = 0;
  const emit = (e: Omit<ScenarioEvent, 'eventId'>) => appendFileSync(eventsFile, JSON.stringify({ eventId: `${runId}#${String(++seq).padStart(3, '0')}`, ...e }) + '\n');

  let abort = false;
  let active: { phase: Phase; injected?: Injected } | undefined;
  let wake: (() => void) | undefined;
  const onSigint = () => {
    if (abort) process.exit(130);
    abort = true;
    console.log('\n\x1b[1;31mSIGINT — reverting active phase (Ctrl-C again to force-quit)\x1b[0m');
    wake?.();
  };
  process.on('SIGINT', onSigint);

  const ctx = (phase: string, shard: number | null): PhaseCtx => ({
    cfg, runId, runDir,
    topo: () => topology(cfg),
    note: (message, data = {}) => {
      console.log(`  · ${message} ${Object.keys(data).length ? JSON.stringify(data) : ''}`);
      emit({ phase, action: 'note', ts: Date.now(), targetShard: shard, targetPods: [], params: { message, ...data }, expected: NO_EXPECT });
    },
    wait: (sec, label) => new Promise<void>((resolve) => {
      const end = Date.now() + sec * 1000;
      const timer = setInterval(() => {
        const left = Math.max(0, Math.round((end - Date.now()) / 1000));
        if (left <= cfg.scenario.countdownFinalSec || left % cfg.scenario.bannerEverySec === 0) process.stdout.write(`\r  ⏱  ${label}: ${fmt(left)} left   `);
        if (left === 0) done();
      }, 1000);
      const done = () => (clearInterval(timer), (wake = undefined), process.stdout.write('\n'), resolve());
      wake = done;
    }),
    aborted: () => abort,
  });

  banner(`RUN ${runId} — ${phases.length} phases, ~${fmt(plan.totalSec)}`);
  const bdbDeploy = await kubectlJson(cfg, ['-n', cfg.betterdb.namespace, 'get', 'deploy', `${cfg.betterdb.release}-betterdb-monitor`]);
  const meta = { betterdbImage: bdbDeploy.spec.template.spec.containers[0].image as string, host: `${cpus().length} vCPU / ${Math.round(totalmem() / 2 ** 30)} GiB, ${platform()} ${release()}` };
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify({ runId, runStart, seed: cfg.seed, phases: phases.map((p) => p.name), timeline: plan, meta, config: cfg }, null, 2));
  await waitClusterReady(cfg, cfg.cluster.readyTimeoutSec);
  writeFileSync(join(runDir, 'topology-start.json'), JSON.stringify([...(await topology(cfg)).values()], null, 2));
  const vc = await kubectlJson(cfg, ['-n', cfg.cluster.namespace, 'get', 'valkeycluster', cfg.cluster.name]);
  emit({ phase: 'run', action: 'start', ts: runStart, targetShard: null, targetPods: [], params: { image: vc.spec.image, betterdbUrl: cfg.betterdb.url }, expected: NO_EXPECT });

  // Load + collectors run across the whole scenario.
  await truthStart(cfg, runId);
  await appGenUp(cfg);
  await setAppRps(cfg, cfg.load.app.rps);
  await memtierStart(cfg, plan.totalSec + cfg.scenario.loadOverrunSec);
  const bdb = startBetterdbCollector(cfg, join(runDir, 'betterdb.jsonl'), runStart);
  const shots = cfg.screenshots.enabled ? new Screenshots(cfg, join(runDir, 'screenshots')) : undefined;

  const failures: string[] = [];
  try {
    banner(`BASELINE — ${fmt(cfg.scenario.baselineSec)} (BetterDB learns a 300-sample window)`);
    emit({ phase: 'baseline', action: 'start', ts: Date.now(), targetShard: null, targetPods: [], params: { sec: cfg.scenario.baselineSec }, expected: NO_EXPECT });
    await ctx('baseline', null).wait(cfg.scenario.baselineSec, 'baseline');
    emit({ phase: 'baseline', action: 'end', ts: Date.now(), targetShard: null, targetPods: [], params: {}, expected: NO_EXPECT });

    for (const [i, phase] of phases.entries()) {
      if (abort) break;
      banner(`PHASE ${i + 1}/${phases.length}: ${phase.name.toUpperCase()} — ${phase.summary(cfg)}`);
      const c = ctx(phase.name, null);
      active = { phase };
      try {
        const injected = await phase.inject(c);
        active.injected = injected;
        emit({ phase: phase.name, action: 'start', ts: injected.ts, targetShard: injected.targetShard, targetPods: injected.targetPods, params: injected.params, expected: injected.expected });
        if (phase.hold) await phase.hold(c, injected);
        else await c.wait(phase.plannedSec(cfg), phase.name);
        // Capture while the fault is still active: after revert() the evidence is gone.
        await shots?.capture(phase.name, injected.targetPods, injected.ts).catch((e: Error) => c.note('screenshot failed', { error: e.message.slice(0, 200) }));
      } catch (e) {
        failures.push(`${phase.name}: ${(e as Error).message}`);
        c.note('phase failed', { error: (e as Error).message.slice(0, 500) });
      } finally {
        await phase.revert(c, active.injected).catch((e: Error) => failures.push(`${phase.name} revert: ${e.message}`));
        emit({ phase: phase.name, action: 'end', ts: Date.now(), targetShard: active.injected?.targetShard ?? null, targetPods: active.injected?.targetPods ?? [], params: { aborted: abort }, expected: NO_EXPECT });
        active = undefined;
      }
      if (abort) break;
      banner(`GAP — ${fmt(cfg.scenario.gapSec)} recovery`);
      await ctx('gap', null).wait(cfg.scenario.gapSec, 'recovery');
    }
  } finally {
    process.off('SIGINT', onSigint);
    banner('COLLECTING');
    const bdbStats = await bdb.stop();
    await shots?.close();
    await truthCollect(cfg, join(runDir, 'groundtruth.jsonl')).catch((e: Error) => failures.push(`truth collect: ${e.message}`));
    await truthStop(cfg);
    writeFileSync(join(runDir, 'appgen.jsonl'), (await appGenLogs(cfg, new Date(runStart).toISOString())).join('\n') + '\n');
    await memtierCollect(cfg, join(runDir, 'memtier.json'));
    const ready = await waitClusterReady(cfg, cfg.cluster.readyTimeoutSec).then(() => true, () => false);
    const pods = (await topology(cfg).catch(() => new Map())).values().next().value?.primary.name;
    const state = pods ? (await valkeyCli(cfg, pods, ['cluster', 'info'])).match(/cluster_state:(\w+)/)?.[1] : 'unknown';
    emit({ phase: 'run', action: 'end', ts: Date.now(), targetShard: null, targetPods: [], params: { aborted: abort, failures, clusterReady: ready, clusterState: state, betterdb: bdbStats }, expected: NO_EXPECT });
    banner(`DONE ${runId}: cluster ${ready ? 'Ready' : 'NOT Ready'}, cluster_state:${state}, ${failures.length} failures`);
    for (const f of failures) console.log(`  ✘ ${f}`);
    console.log(`  → ${runDir}`);
  }
  return { runId, runDir };
}
