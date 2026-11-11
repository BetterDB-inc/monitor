// Prospect pack: a shareable PDF (summary page + a few panel-cropped screenshots) and the PNGs.
// Operator findings lead; numbers come from the runs' own files. Prose that isn't derivable
// from a run (repro outcomes, product follow-ups) comes from `prospect.notes` in sim.yaml.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { marked } from 'marked';
import { chromium } from 'playwright-core';
import type { SimConfig } from '../config.js';
import type { ScenarioEvent } from '../scenario/phase.js';
import { correlate, type PhaseFinding } from './correlate.js';

const ROOT = new URL('../..', import.meta.url).pathname;

const NAME: Record<string, string> = {
  spike: 'Traffic spike', hotShard: 'Hot shard', slowCommands: 'Slow commands', memoryPressure: 'Memory pressure',
  replicaLag: 'Replica lag', primaryKill: 'Primary kill', rollingUpdate: 'Rolling update',
};
const name = (p: string) => NAME[p] ?? p;
const sec = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
// Detection before our own 1 s / 5 s ground-truth sampling registered the signal.
const fromSignal = (ms: number | null) => (ms !== null && ms < 0 ? 'before our sampling saw it' : sec(ms));

interface Item { runId: string; runDir: string; f: PhaseFinding }

export async function prospect(cfg: SimConfig, runIds: string[]) {
  const P = cfg.prospect;
  const items: Item[] = [];
  let falsePositives = 0;
  let observedMs = 0;
  let baselineEndSec = 0;
  const fps: { ts: number; metric: string | null; pattern: string | null; offsetSec: number }[] = [];
  const fpByMetric: Record<string, number> = {};
  for (const runId of runIds) {
    const runDir = join(ROOT, 'runs', runId);
    const events = readFileSync(join(runDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ScenarioEvent);
    const t = (phase: string, action: string) => events.find((e) => e.phase === phase && e.action === action)?.ts;
    observedMs += (t('run', 'end') ?? 0) - (t('run', 'start') ?? 0);
    baselineEndSec = Math.max(baselineEndSec, ((t('baseline', 'end') ?? 0) - (t('run', 'start') ?? 0)) / 1000);
    const c = correlate(runDir, cfg);
    falsePositives += c.falsePositives.length;
    for (const f of c.falsePositives) fps.push({ ts: f.ts, metric: f.metric, pattern: f.pattern, offsetSec: (f.ts - c.runStart) / 1000 });
    for (const [m, n] of Object.entries(c.fpByMetric)) fpByMetric[m] = (fpByMetric[m] ?? 0) + n;
    // A phase re-run in a later run supersedes the earlier one.
    for (const f of c.phases) {
      const i = items.findIndex((x) => x.f.phase === f.phase);
      if (i >= 0) items[i] = { runId, runDir, f };
      else items.push({ runId, runDir, f });
    }
  }
  items.sort((a, b) => cfg.scenario.phases.indexOf(a.f.phase as never) - cfg.scenario.phases.indexOf(b.f.phase as never));
  const get = (p: string) => items.find((x) => x.f.phase === p)?.f;

  const outDir = join(ROOT, 'runs', runIds.at(-1)!, 'prospect');
  mkdirSync(outDir, { recursive: true });

  // ── operator section (leads) ────────────────────────────────────────────
  const roll = get('rollingUpdate');
  const kill = get('primaryKill');
  const zero = Object.values(((roll?.truth as any)?.zeroReplica ?? {}) as Record<string, { longest: { fromSec: number; toSec: number } }>).map((z) => z.longest.toSec - z.longest.fromSec + 1);
  const operator = [
    roll && zero.length
      ? `- **Every shard briefly had no replica during a rolling update.** Operator ${cfg.charts.valkeyOperator!.version}, image roll across all 36 pods (${sec(roll.end - roll.start)}): in **${zero.length} of ${cfg.cluster.shards} shards the primary had zero attached replicas for ${Math.min(...zero)}–${Math.max(...zero)} s** (INFO \`connected_slaves\`, sampled every second). The second replica is restarted before the first has rejoined: the restarted pod comes back as an empty \`master\`, Kubernetes marks it Ready, and the operator moves on. Without persistence, losing the primary inside that window loses the shard. This is valkey-operator #552 (#563 was closed as its duplicate); our per-second data matches the mechanism the open fix PR #562 describes.${P.notes.zeroReplica ? ` ${P.notes.zeroReplica}` : ''}`
      : null,
    P.notes.ghostMaster ? `- ${P.notes.ghostMaster}` : null,
    roll ? `- **Planned rolls page like incidents today.** Role changes during an operator roll raise \`replication_role\` CRITICAL and \`node_failover\` findings; BetterDB has no maintenance window or roll-aware suppression yet, and the per-detector settings only change thresholds.${P.notes.plannedRolls ? ` ${P.notes.plannedRolls}` : ''}` : null,
    kill ? `- Primary kill (graceful pod delete): replica promoted after ${sec((kill.truth as any).promotedAfterMs)}; BetterDB reported the failover ${sec(kill.firstDetectionMs)} after the delete.` : null,
  ].filter(Boolean).join('\n');

  // ── detection table ────────────────────────────────────────────────────
  const detected = items.filter((x) => x.f.detected).length;
  const rows = items.map(({ f }) => {
    const m = f.matched[0];
    const said = m ? `${m.pattern ?? m.metric} (${m.severity})` : '**not detected**';
    return `| ${name(f.phase)} | ${f.targetShard === null ? 'whole cluster' : `shard ${f.targetShard}`} | ${f.detected ? 'yes' : '**no**'} | ${fromSignal(f.onsetToDetectionMs)} | ${sec(f.firstDetectionMs)} | ${said} |`;
  });

  // ── noise in context ───────────────────────────────────────────────────
  // Split by the recorded baseline end: a burst while BetterDB learns its baseline is a
  // different statement from a steady rate during normal operation.
  const isSlow = (f: (typeof fps)[number]) => P.slowlogMetrics.includes(f.metric ?? `group:${f.pattern}`);
  const slow = fps.filter(isSlow);
  const inWarmup = fps.filter((f) => f.offsetSec <= baselineEndSec);
  const after = fps.filter((f) => f.offsetSec > baselineEndSec);
  const breakdown = (xs: typeof fps) => Object.entries(xs.reduce((a: Record<string, number>, f) => ((a[f.metric ?? `group:${f.pattern}`] = (a[f.metric ?? `group:${f.pattern}`] ?? 0) + 1), a), {})).sort((x, y) => y[1] - x[1]).map(([m, n]) => `${m} ${n}`).join(', ');
  const warmupMin = Math.round(baselineEndSec / 60);
  const afterMin = Math.round(observedMs / 60000 - baselineEndSec / 60);
  const slowRest = slow.filter((f) => f.offsetSec <= baselineEndSec);
  // Three sentences: where the noise fell, what it was, what's left after warm-up.
  const noise = [
    inWarmup.length === falsePositives && falsePositives > 0
      ? `All ${falsePositives} out-of-window findings fell in the ${warmupMin}-minute warm-up, when BetterDB had just been deployed onto an idle cluster and load started on every connection at once.`
      : `${inWarmup.length} of the ${falsePositives} out-of-window findings fell in the ${warmupMin}-minute warm-up, when BetterDB had just been deployed onto an idle cluster and load started on every connection at once.`,
    slowRest.length ? `${slowRest.length} of them were slowlog alerts; on the primaries, where we sampled the slowlog ourselves, most of the entries behind them were BetterDB's own polling commands, so excluding our own client and adding a minimum-count floor are the fixes.` : '',
    `After warm-up: ${after.length} finding${after.length === 1 ? '' : 's'} outside the fault windows in ${afterMin} minutes.`,
  ].filter(Boolean).join(' ');

  // The slowest detection gets a one-line explanation when it's the slow-commands phase.
  const slowest = [...items].filter((x) => x.f.onsetToDetectionMs !== null).sort((a, b) => b.f.onsetToDetectionMs! - a.f.onsetToDetectionMs!)[0]?.f;
  const others = items.filter((x) => x.f !== slowest && x.f.onsetToDetectionMs !== null && x.f.onsetToDetectionMs > 0).map((x) => x.f.onsetToDetectionMs!);
  const slowNote = slowest?.phase === 'slowCommands' && others.length
    ? `Slow commands is the slowest (${sec(slowest.onsetToDetectionMs)} from first signal, vs ${sec(Math.min(...others))}–${sec(Math.max(...others))} for the rest) because ${P.notes.slowCommands}`
    : '';

  const md = `# BetterDB Monitor on a 12-shard Valkey cluster run by the official operator

> **What this is:** tested on a 12-shard Valkey cluster with 2 replicas per shard (36 pods, valkey-operator ${cfg.charts.valkeyOperator!.version}), running on a single host with kind under a synthetic messaging-style workload. **Not production numbers**: times below are relative, on this rig.

**Setup.** Valkey ${cfg.cluster.valkeyImage.split(':')[1]}, cluster mode, no persistence. BetterDB Monitor ${P.buildLabel}, seeded with the operator's headless Service, auto&#8209;registering all 36 nodes, polling every second. ${items.length} faults injected on a fixed seed and timeline; BetterDB's findings compared against per-node ground truth we sampled independently.

## What we saw in the operator's lifecycle

${operator}

## Detection: ${detected} of ${items.length} faults found on the right node or shard

| fault | where | detected | from first signal | from injection | BetterDB's first finding |
|---|---|---|---|---|---|
${rows.join('\n')}

*From first signal* starts at the first evidence in ground truth (first eviction, first slowlog entry, replica promotion), so it's the fair number. ${slowNote}

**Noise.** ${noise}

${P.notes.repro}
`;

  // ── screenshots: only the panels that prove a claim on their own ───────
  const shots = P.shots.map((phase) => {
    const it = items.find((x) => x.f.phase === phase);
    const src = it && join(it.runDir, 'screenshots', `${phase}-panel.png`);
    if (!src || !existsSync(src)) return null;
    const file = `${phase}.png`;
    copyFileSync(src, join(outDir, file));
    return { phase, file, caption: P.captions[phase] ?? '' };
  }).filter((x): x is { phase: string; file: string; caption: string } => !!x);

  writeFileSync(join(outDir, 'REPORT.md'), md + '\n' + shots.map((s) => `![${name(s.phase)}](${s.file})\n\n*${s.caption}*\n`).join('\n') + `\n${P.signature}\n`);

  const gallery = shots.map((s) => `<section class="shot"><h3>${name(s.phase)}</h3><p>${s.caption}</p><img src="data:image/png;base64,${readFileSync(join(outDir, s.file)).toString('base64')}"></section>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
body{font:9.5px/1.4 -apple-system,Segoe UI,sans-serif;margin:0;color:#111}h1{font-size:15px;margin:0 0 6px}h2{font-size:11.5px;margin:10px 0 4px}h3{font-size:11px;margin:0 0 3px}
table{border-collapse:collapse;width:100%;margin:5px 0}td,th{border:1px solid #ccc;padding:2px 5px;text-align:left;vertical-align:top}th{background:#f3f4f6}
blockquote{margin:5px 0;padding:4px 8px;border-left:3px solid #0f766e;background:#f0fdfa}p,ul{margin:4px 0}li{margin:2px 0}
.gallery{page-break-before:always}.shot{break-inside:avoid;margin-bottom:8mm}.shot img{max-width:100%;max-height:120mm;border:1px solid #ddd}.by{color:#666;margin-top:8px}
</style>${await marked.parse(md)}<p class="by">${P.signature}</p><div class="gallery">${gallery}</div>`;
  const browser = await chromium.launch({ executablePath: cfg.report.chromiumPath });
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: join(outDir, 'BetterDB-Valkey-operator-simulation.pdf'), format: 'A4', margin: { top: '11mm', bottom: '11mm', left: '12mm', right: '12mm' } });
  await browser.close();
  console.log(md);
  console.log(`→ ${outDir}`);
  return outDir;
}
