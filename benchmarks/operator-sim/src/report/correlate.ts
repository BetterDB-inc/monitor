// Pure: runs/<id>/{events,groundtruth,betterdb}.jsonl + plan.json → per-phase findings.
// No clocks, no network; same inputs → byte-identical output.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimConfig } from '../config.js';
import type { ScenarioEvent } from '../scenario/phase.js';

export interface Truth { ts: number; pod: string; shard: number; role: string; metric: string; value: any }
export interface Detection {
  source: 'event' | 'group';
  id: string;
  ts: number;
  firstSeenAt: number;
  pod: string | null;
  shard: number | null;
  metric: string | null;
  pattern: string | null;
  severity: string;
  text: string;
}
export interface PhaseFinding {
  eventId: string;
  phase: string;
  targetShard: number | null;
  targetPods: string[];
  start: number;
  end: number;
  windowEnd: number;
  detected: boolean;
  firstDetectionMs: number | null;
  onsetTs: number | null;
  onsetToDetectionMs: number | null;
  onsetSignal: string;
  nodeMatch: 'exact' | 'same-shard' | 'other-shard' | 'cluster-wide' | null;
  matched: { metric: string | null; pattern: string | null; severity: string; pod: string | null; afterMs: number; text: string }[];
  offTarget: number;
  diagnosis: string | null;
  truth: Record<string, unknown>;
}
export interface FalsePositive extends Detection { during: string }
export interface Correlation { runId: string; runStart: number; phases: PhaseFinding[]; falsePositives: FalsePositive[]; fpByMetric: Record<string, number>; collectorErrors: number }

const readJsonl = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []);

function detections(raw: any[]): Detection[] {
  const out: Detection[] = [];
  for (const r of raw) {
    if (r.kind === 'event') {
      const e = r.payload;
      out.push({ source: 'event', id: e.id, ts: e.timestamp, firstSeenAt: r.firstSeenAt, pod: r.pod, shard: r.shard, metric: e.metricType, pattern: null, severity: e.severity, text: e.message });
    } else if (r.kind === 'group') {
      const g = r.payload;
      out.push({ source: 'group', id: g.correlationId, ts: g.timestamp, firstSeenAt: r.firstSeenAt, pod: r.pod, shard: r.shard, metric: null, pattern: g.pattern, severity: g.severity, text: g.diagnosis });
    }
  }
  // Groups are re-emitted as they grow; keep the first sighting of each.
  const seen = new Set<string>();
  return out.filter((d) => (seen.has(`${d.source}:${d.id}`) ? false : (seen.add(`${d.source}:${d.id}`), true))).sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

const series = (truth: Truth[], metric: string, pred: (t: Truth) => boolean = () => true) => truth.filter((t) => t.metric === metric && pred(t));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Per-second cluster or per-pod ops, baseline = the `baselineSec` before start.
function opsOnset(truth: Truth[], start: number, end: number, cfg: SimConfig, pods?: Set<string>) {
  const pts = series(truth, 'instantaneous_ops_per_sec', (t) => t.role === 'primary' && (!pods || pods.has(t.pod)));
  const bySec = new Map<number, number>();
  for (const t of pts) bySec.set(Math.floor(t.ts / 1000), (bySec.get(Math.floor(t.ts / 1000)) ?? 0) + Number(t.value));
  const base = mean([...bySec].filter(([s]) => s * 1000 < start && s * 1000 >= start - cfg.report.onsetBaselineSec * 1000).map(([, v]) => v));
  const hit = [...bySec].filter(([s, v]) => s * 1000 >= start && s * 1000 <= end && v > base * cfg.report.opsOnsetFactor).sort((a, b) => a[0] - b[0])[0];
  return { ts: hit ? hit[0] * 1000 : null, baseline: Math.round(base), peak: Math.max(0, ...[...bySec].filter(([s]) => s * 1000 >= start && s * 1000 <= end).map(([, v]) => v)) };
}

function groundTruth(phase: string, ev: ScenarioEvent, end: number, truth: Truth[], cfg: SimConfig): { onsetTs: number | null; signal: string; facts: Record<string, unknown> } {
  const start = ev.ts;
  const pods = new Set(ev.targetPods);
  const inWin = (t: Truth) => t.ts >= start && t.ts <= end;
  switch (phase) {
    case 'spike': {
      const o = opsOnset(truth, start, end, cfg);
      return { onsetTs: o.ts, signal: `cluster ops/s > ${cfg.report.opsOnsetFactor}× baseline`, facts: { baselineOps: o.baseline, peakOps: o.peak } };
    }
    case 'hotShard': {
      const o = opsOnset(truth, start, end, cfg, pods);
      return { onsetTs: o.ts, signal: `target primary ops/s > ${cfg.report.opsOnsetFactor}× baseline`, facts: { baselineOps: o.baseline, peakOps: o.peak } };
    }
    case 'slowCommands': {
      const slow = truth.filter((t) => (t.metric === 'slowlog' || t.metric === 'commandlog') && t.shard === ev.targetShard && t.value.ts >= start - 1000 && t.value.ts <= end);
      const first = slow.map((t) => t.value.ts as number).sort((a, b) => a - b)[0] ?? null;
      const us = slow.map((t) => Number(t.value.durationUs));
      return { onsetTs: first, signal: 'first slowlog entry on target shard', facts: { slowlogEntries: slow.filter((t) => t.metric === 'slowlog').length, maxDurationMs: us.length ? Math.round(Math.max(...us) / 1000) : null } };
    }
    case 'memoryPressure': {
      const ev2 = series(truth, 'evicted_keys', (t) => pods.has(t.pod)).sort((a, b) => a.ts - b.ts);
      const before = ev2.filter((t) => t.ts < start).at(-1)?.value ?? 0;
      const first = ev2.find((t) => inWin(t) && Number(t.value) > Number(before));
      const last = ev2.filter(inWin).at(-1);
      const mm = series(truth, 'maxmemory', (t) => pods.has(t.pod) && inWin(t)).map((t) => Number(t.value));
      return { onsetTs: first?.ts ?? null, signal: 'first evicted_keys increase on target primary', facts: { evicted: last ? Number(last.value) - Number(before) : 0, maxmemorySeen: [...new Set(mm)] } };
    }
    case 'replicaLag': {
      const [primary, replica] = ev.targetPods;
      const p = series(truth, 'master_repl_offset', (t) => t.pod === primary).sort((a, b) => a.ts - b.ts);
      const r = series(truth, 'slave_repl_offset', (t) => t.pod === replica).concat(series(truth, 'master_repl_offset', (t) => t.pod === replica && t.role === 'replica')).sort((a, b) => a.ts - b.ts);
      let onset: number | null = null;
      let maxLag = 0;
      for (const x of r.filter(inWin)) {
        const pp = p.filter((y) => y.ts <= x.ts).at(-1);
        if (!pp) continue;
        const lag = Number(pp.value) - Number(x.value);
        maxLag = Math.max(maxLag, lag);
        if (onset === null && lag > cfg.report.replLagOnsetBytes) onset = x.ts;
      }
      const link = series(truth, 'master_link_status', (t) => t.pod === replica && inWin(t)).filter((t) => t.value !== 'up').length;
      return { onsetTs: onset, signal: `replica offset lag > ${cfg.report.replLagOnsetBytes} B`, facts: { maxLagBytes: maxLag, linkDownSamples: link } };
    }
    case 'primaryKill': {
      const rc = truth.filter((t) => t.metric === 'role_change' && t.shard === ev.targetShard && inWin(t) && t.value.to === 'primary').sort((a, b) => a.ts - b.ts)[0];
      return { onsetTs: rc?.ts ?? start, signal: rc ? 'replica promoted (role_change)' : 'pod deleted (injection ts)', facts: { promoted: rc?.pod ?? null, promotedAfterMs: rc ? rc.ts - start : null } };
    }
    case 'rollingUpdate': {
      const rcs = truth.filter((t) => t.metric === 'role_change' && inWin(t) && t.value.to === 'primary');
      const perShard: Record<number, number[]> = {};
      for (const t of rcs) (perShard[t.shard] ??= []).push(t.ts - start);
      return { onsetTs: rcs.map((t) => t.ts).sort((a, b) => a - b)[0] ?? null, signal: 'first promotion during roll', facts: { promotionsPerShard: perShard, zeroReplica: zeroReplicaRuns(truth, start, end), noSyncedReplicaWindows: noSyncedReplica(truth, start, end, cfg) } };
    }
    default:
      return { onsetTs: null, signal: 'n/a', facts: {} };
  }
}

// Per shard: spans where no replica reported master_link_status:up (operator #563).
// A replica that is syncing, down, or whose pod is gone mid-roll counts as not synced.
// Sampled every truth.replicaIntervalSec, so span edges are ± that granularity.
export function noSyncedReplica(truth: Truth[], start: number, end: number, cfg: SimConfig) {
  const step = cfg.truth.replicaIntervalSec * 1000;
  const links = truth.filter((t) => t.metric === 'master_link_status' && t.role === 'replica' && t.ts >= start && t.ts <= end);
  const out: Record<number, { fromMs: number; toMs: number }[]> = {};
  for (let t = start + step; t <= end; t += step) {
    const up = new Set(links.filter((x) => x.ts > t - step && x.ts <= t && x.value === 'up').map((x) => x.shard));
    for (let s = 0; s < cfg.cluster.shards; s++) {
      if (up.has(s)) continue;
      const spans = (out[s] ??= []);
      const last = spans.at(-1);
      if (last && last.toMs === t - step - start) last.toMs = t - start;
      else spans.push({ fromMs: t - step - start, toMs: t - start });
    }
  }
  return out;
}

// Per shard: runs of seconds in which no pod reporting role:primary had any replica attached
// (INFO connected_slaves, sampled every truth.primaryIntervalSec). Fresh, not-yet-joined pods
// also report role:primary with 0 replicas, so a second counts only if *every* primary-role
// pod of the shard reports 0 — i.e. the real primary too. Operator #563.
export function zeroReplicaRuns(truth: Truth[], start: number, end: number) {
  const bySec = new Map<number, Map<number, number>>();
  for (const t of truth) {
    if (t.metric !== 'connected_slaves' || t.role !== 'primary' || t.ts < start || t.ts > end) continue;
    const sec = Math.floor((t.ts - start) / 1000);
    const m = bySec.get(t.shard) ?? new Map<number, number>();
    m.set(sec, Math.max(m.get(sec) ?? 0, Number(t.value)));
    bySec.set(t.shard, m);
  }
  const out: Record<number, { totalSec: number; longest: { fromSec: number; toSec: number } | null }> = {};
  for (const [shard, m] of [...bySec].sort((a, b) => a[0] - b[0])) {
    const zero = [...m].filter(([, v]) => v === 0).map(([s]) => s).sort((a, b) => a - b);
    let best: { fromSec: number; toSec: number } | null = null;
    let from = zero[0];
    for (let i = 0; i < zero.length; i++) {
      if (i === zero.length - 1 || zero[i + 1] !== zero[i]! + 1) {
        if (!best || zero[i]! - from! > best.toSec - best.fromSec) best = { fromSec: from!, toSec: zero[i]! };
        from = zero[i + 1];
      }
    }
    if (zero.length) out[shard] = { totalSec: zero.length, longest: best };
  }
  return out;
}

export function correlate(runDir: string, cfg: SimConfig): Correlation {
  const plan = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'));
  const events = readJsonl<ScenarioEvent>(join(runDir, 'events.jsonl'));
  const truth = readJsonl<Truth>(join(runDir, 'groundtruth.jsonl'));
  const rawB = readJsonl<any>(join(runDir, 'betterdb.jsonl'));
  const dets = detections(rawB);
  const W = cfg.betterdb.matchWindowSec * 1000;

  const starts = events.filter((e) => e.action === 'start' && e.phase !== 'run' && e.phase !== 'baseline');
  const ends = new Map(events.filter((e) => e.action === 'end').map((e) => [e.phase, e.ts]));
  const runEnd = events.find((e) => e.phase === 'run' && e.action === 'end')?.ts ?? Math.max(...events.map((e) => e.ts));
  const windows = starts.map((s, i) => {
    const end = ends.get(s.phase) ?? runEnd;
    // Don't let a phase's match window swallow the next injection.
    const next = starts[i + 1]?.ts ?? Infinity;
    return { s, end, windowEnd: Math.min(end + W, next, runEnd) };
  });

  const claimed = new Set<string>();
  const phases: PhaseFinding[] = windows.map(({ s, end, windowEnd }) => {
    const exp = s.expected;
    const pods = new Set(s.targetPods);
    const inWin = dets.filter((d) => d.ts >= s.ts && d.ts <= windowEnd);
    inWin.forEach((d) => claimed.add(`${d.source}:${d.id}`));
    const relevant = inWin.filter((d) => (d.metric && exp.metrics.includes(d.metric)) || (d.pattern && exp.patterns.includes(d.pattern)));
    const onTarget = relevant.filter((d) => d.pod === null || pods.has(d.pod) || d.shard === s.targetShard || s.targetShard === null);
    const first = onTarget[0] ?? null;
    const nodeMatch = first ? (first.pod === null ? 'cluster-wide' : pods.has(first.pod) ? 'exact' : first.shard === s.targetShard ? 'same-shard' : s.targetShard === null ? 'exact' : 'other-shard') : null;
    const gt = groundTruth(s.phase, s, end, truth, cfg);
    return {
      eventId: s.eventId, phase: s.phase, targetShard: s.targetShard, targetPods: s.targetPods,
      start: s.ts, end, windowEnd,
      detected: !!first,
      firstDetectionMs: first ? first.ts - s.ts : null,
      onsetTs: gt.onsetTs,
      onsetToDetectionMs: first && gt.onsetTs !== null ? first.ts - gt.onsetTs : null,
      onsetSignal: gt.signal,
      nodeMatch,
      matched: onTarget.slice(0, cfg.report.maxMatchedPerPhase).map((d) => ({ metric: d.metric, pattern: d.pattern, severity: d.severity, pod: d.pod, afterMs: d.ts - s.ts, text: d.text.slice(0, cfg.report.textChars) })),
      offTarget: inWin.length - onTarget.length,
      diagnosis: onTarget.find((d) => d.source === 'group')?.text.slice(0, cfg.report.textChars) ?? null,
      truth: gt.facts,
    };
  });

  const warmupEnd = plan.runStart + cfg.report.warmupSec * 1000;
  const baselineEnd = events.find((e) => e.phase === 'baseline' && e.action === 'end')?.ts ?? warmupEnd;
  const falsePositives = dets
    .filter((d) => !claimed.has(`${d.source}:${d.id}`) && d.ts >= warmupEnd)
    .map((d) => ({ ...d, during: d.ts < baselineEnd ? 'baseline' : (windows.findLast((w) => w.s.ts <= d.ts)?.s.phase ?? 'baseline') + '+gap' }));
  const fpByMetric: Record<string, number> = {};
  for (const f of falsePositives) fpByMetric[f.metric ?? `group:${f.pattern}`] = (fpByMetric[f.metric ?? `group:${f.pattern}`] ?? 0) + 1;
  return { runId: plan.runId, runStart: plan.runStart, phases, falsePositives, fpByMetric: Object.fromEntries(Object.entries(fpByMetric).sort()), collectorErrors: rawB.filter((r) => r.kind === 'collector_error').length };
}
