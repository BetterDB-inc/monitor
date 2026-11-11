// Pure rendering: Correlation + plan → findings.jsonl, SUMMARY.md, timeline SVG, and the
// run's section in FINDINGS.md (replaced in place, so re-running is idempotent).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimConfig } from '../config.js';
import type { ScenarioEvent } from '../scenario/phase.js';
import type { Correlation, PhaseFinding } from './correlate.js';

const s = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);
const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function truthCell(f: PhaseFinding) {
  const t = f.truth as any;
  switch (f.phase) {
    case 'spike':
    case 'hotShard': return `ops/s ${t.baselineOps} → peak ${t.peakOps}`;
    case 'slowCommands': return `${t.slowlogEntries} slowlog entries, max ${t.maxDurationMs ?? '—'} ms`;
    case 'memoryPressure': return `${t.evicted} keys evicted; maxmemory seen ${(t.maxmemorySeen ?? []).join('/')}`;
    case 'replicaLag': return `max lag ${(t.maxLagBytes / 2 ** 20).toFixed(1)} MiB, link-down samples ${t.linkDownSamples}`;
    case 'primaryKill': return t.promoted ? `${t.promoted} promoted after ${s(t.promotedAfterMs)}` : 'no promotion seen';
    case 'rollingUpdate': return `${Object.keys(t.promotionsPerShard ?? {}).length}/12 shards promoted; ${Object.keys(t.zeroReplica ?? {}).length} shards had a primary with 0 attached replicas`;
    default: return '';
  }
}

// First on-target detection in BetterDB's own words; a correlated group's diagnosis is
// shown separately so a metric label is never paired with another detector's text.
function whatSaid(f: PhaseFinding) {
  if (!f.detected) return '**MISS**';
  const m = f.matched[0]!;
  const group = f.matched.find((x) => x.pattern);
  const first = `${m.severity} ${m.pattern ?? m.metric}${m.pod ? ` @${m.pod}` : ''}: ${m.text.slice(0, 90)}`;
  return esc(group && group !== m ? `${first}; group ${group.pattern}: ${group.text.slice(0, 70)}` : first);
}

export function timelineSvg(c: Correlation, runEnd: number) {
  const W = 900, H = 40 + c.phases.length * 22, x = (ts: number) => 140 + ((ts - c.runStart) / (runEnd - c.runStart)) * (W - 160);
  const rows = c.phases.map((f, i) => {
    const y = 30 + i * 22;
    const det = f.firstDetectionMs !== null ? `<circle cx="${x(f.start + f.firstDetectionMs).toFixed(1)}" cy="${y + 6}" r="4" fill="var(--hit)"/>` : `<text x="${(x(f.end) + 6).toFixed(1)}" y="${y + 10}" font-size="10" fill="var(--miss)">miss</text>`;
    return `<text x="4" y="${y + 10}" font-size="11">${f.phase}</text><rect x="${x(f.start).toFixed(1)}" y="${y}" width="${Math.max(2, x(f.end) - x(f.start)).toFixed(1)}" height="12" fill="var(--inj)"/>${det}`;
  });
  const fps = c.falsePositives.map((f) => `<line x1="${x(f.ts).toFixed(1)}" x2="${x(f.ts).toFixed(1)}" y1="${H - 12}" y2="${H - 4}" stroke="var(--miss)"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif" style="--inj:#7aa2f7;--hit:#1a7f37;--miss:#cf222e">
<text x="4" y="14" font-size="11" font-weight="bold">injections (bars), first on-target detection (dots), unmatched detections (ticks)</text>
${rows.join('\n')}
<text x="4" y="${H - 4}" font-size="10">FPs (${c.falsePositives.length})</text>${fps.join('')}
</svg>\n`;
}

export function renderSummary(c: Correlation, cfg: SimConfig, events: ScenarioEvent[], meta: { betterdbImage: string; host: string }) {
  const runStartEv = events.find((e) => e.phase === 'run' && e.action === 'start');
  const runEndEv = events.find((e) => e.phase === 'run' && e.action === 'end');
  const hits = c.phases.filter((f) => f.detected).length;
  const roll = c.phases.find((f) => f.phase === 'rollingUpdate');
  const rollT = roll?.truth as any;
  const kill = c.phases.find((f) => f.phase === 'primaryKill');
  const noSync = rollT?.noSyncedReplicaWindows ?? {};
  const zeroShards = Object.entries(rollT?.zeroReplica ?? {}).map(([sh, z]: any) => `shard ${sh} ${z.longest.toSec - z.longest.fromSec + 1} s`);
  const noSyncShards = Object.entries(noSync).map(([sh, spans]: any) => `shard ${sh}: ${spans.map((x: any) => `${(x.fromMs / 1000).toFixed(0)}–${(x.toMs / 1000).toFixed(0)} s`).join(', ')}`);
  const promos = Object.entries(rollT?.promotionsPerShard ?? {}).map(([sh, ms]: any) => [Number(sh), Math.min(...ms)] as const).sort((a, b) => a[1] - b[1]);
  const topFp = Object.entries(c.fpByMetric).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, n]) => `${m} ×${n}`).join(', ');
  const failures = (runEndEv?.params.failures as string[] | undefined) ?? [];

  return `# BetterDB Monitor vs. a 12×2 Valkey cluster — run \`${c.runId}\`

> Tested on a 12-shard × 2-replica Valkey cluster on a single host (kind); synthetic workload; **not prod numbers**. Times are detection latencies on this rig, not SLAs.

**Setup.** ${cfg.cluster.shards} shards × (1 + ${cfg.cluster.replicasPerShard}) = ${cfg.cluster.shards * (1 + cfg.cluster.replicasPerShard)} pods, cluster mode, valkey-operator ${cfg.charts.valkeyOperator!.version}, \`${runStartEv?.params.image ?? cfg.cluster.valkeyImage}\`, maxmemory ${cfg.cluster.maxmemory}/node, no persistence. kind ${cfg.kind.nodeImage.split('@')[0]!.split(':')[1]} on ${meta.host}. BetterDB \`${meta.betterdbImage}\`, headless-Service seed, 36 auto-registered node connections, 1 s anomaly poll. Load: app-gen ${cfg.load.app.rps} rps (GLIDE, messaging mix) + memtier ${cfg.load.memtier.clients * cfg.load.memtier.threads * cfg.load.memtier.ratePerConn} req/s; ${cfg.dataset.keys.toLocaleString('en-US')} keys preloaded.

**Result: ${hits}/${c.phases.length} injections detected on target; ${c.falsePositives.length} unmatched detections (false positives)${topFp ? ` — ${topFp}` : ''}.**${failures.length ? ` Harness failures: ${failures.map(esc).join('; ')}.` : ''}

| phase | target | detected | inject→detect | onset→detect | what BetterDB said | ground truth |
|---|---|---|---|---|---|---|
${c.phases.map((f) => `| ${f.phase} | ${f.targetShard === null ? 'cluster' : `shard ${f.targetShard}`} | ${f.detected ? `yes (${f.nodeMatch})` : '**no**'} | ${s(f.firstDetectionMs)} | ${s(f.onsetToDetectionMs)} | ${whatSaid(f)} | ${esc(truthCell(f))} |`).join('\n')}

"onset→detect" measures from the first ground-truth signal (e.g. first eviction, first slowlog entry, replica promotion), which is the fairer number; negative = BetterDB flagged before our 1 s/5 s truth sampling saw it.

**Misses and false positives.** ${c.phases.filter((f) => !f.detected).map((f) => `${f.phase} (expected ${(events.find((e) => e.eventId === f.eventId)?.expected.patterns ?? []).join('/')})`).join('; ') || 'No misses.'} Unmatched detections by metric: ${Object.entries(c.fpByMetric).map(([m, n]) => `${m} ${n}`).join(', ') || 'none'}.

**Operator lifecycle observations.**
${[
  kill ? `Primary kill (shard ${kill.targetShard}): ${truthCell(kill)}; BetterDB ${kill.detected ? `flagged ${kill.matched[0]!.pattern ?? kill.matched[0]!.metric} after ${s(kill.firstDetectionMs)}` : 'did not flag it'}.` : 'Primary kill not run.',
  roll ? `Rolling update took ${s(roll.end - roll.start)}; first/last shard promotion at ${promos.length ? `${s(promos[0]![1])} / ${s(promos.at(-1)![1])}` : '—'}.` : 'Rolling update not run.',
  roll ? (zeroShards.length ? `Primary with zero attached replicas during the roll (${cfg.truth.primaryIntervalSec} s sampling of connected_slaves; cf. operator #563) in ${zeroShards.length}/${cfg.cluster.shards} shards — longest per shard: ${zeroShards.join(', ')}.` : `Every primary kept at least one attached replica throughout the roll (${cfg.truth.primaryIntervalSec} s sampling).`) : null,
  roll && noSyncShards.length ? `Spans with no replica reporting master_link_status:up (${cfg.truth.replicaIntervalSec} s sampling): ${noSyncShards.join('; ')}.` : null,
].filter(Boolean).map((x) => `- ${x}`).join('\n')}

**Next steps.** Repeat on dedicated hardware to remove host-contention noise; run the hard-kill variant; compare stock v0.55.0 against the counter-rate fix branch on the same timeline.
`;
}

const BEGIN = (id: string) => `<!-- run:${id} -->`;
const END = (id: string) => `<!-- /run:${id} -->`;

export function upsertFindingsSection(findingsPath: string, c: Correlation, body: string) {
  const cur = existsSync(findingsPath) ? readFileSync(findingsPath, 'utf8') : '# FINDINGS\n';
  const block = `${BEGIN(c.runId)}\n## Run ${c.runId} (${new Date(c.runStart).toISOString()})\n\n${body}\n${END(c.runId)}`;
  const re = new RegExp(`${BEGIN(c.runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END(c.runId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  writeFileSync(findingsPath, re.test(cur) ? cur.replace(re, block) : `${cur.trimEnd()}\n\n${block}\n`);
}

export function writeFindingsJsonl(runDir: string, c: Correlation) {
  const lines = c.phases.map((f) => JSON.stringify(f));
  lines.push(JSON.stringify({ falsePositives: c.falsePositives.length, fpByMetric: c.fpByMetric, collectorErrors: c.collectorErrors }));
  writeFileSync(join(runDir, 'findings.jsonl'), lines.join('\n') + '\n');
}
