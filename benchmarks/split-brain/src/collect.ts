import {
  DEFAULT_VARIANT,
  JOIN_VARIANTS,
  type JudgeSetting,
  MIN_ROUNDS,
  PHASES,
  PreparedTrace,
  type ReplayResult,
  STRATEGIES,
  type Vantage,
  replay,
  seedOnly,
} from './replay';
import { parseView } from './cluster';
import { TICK_MS } from './config';
import type { TrialMeta } from './scenarios';
import type { Trace } from './trace';

export type Side = 'all' | 'faulted' | 'healthy';

export interface Spread {
  n: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
}

export interface Cell {
  strategy: string;
  minRounds: number;
  variant: string;
  vantage: Vantage;
  side: Side;
  replays: number;
  raised: number;
  critical: number;
  early: number;
  late: number;
  ttd: Spread | null;
  kinds: Record<string, number>;
  blame: { faulted: number; healthy: number; mixed: number };
  closed: Spread | null;
  stillOpen: number;
  rounds: number;
  comparable: number;
  views: number;
  reads: number;
  bytes: number;
  migrationChecks: number;
}

export interface SeedOnlyCell {
  side: Side;
  seeds: number;
  duplicatePrimary: number;
  duplicatePrimaryTtd: Spread | null;
  clusterStateFail: number;
  clusterStateFailTtd: Spread | null;
  silent: number;
}

export interface TrialOutput {
  trial: string;
  scenario: string;
  kind: 'fault' | 'control';
  rep: number;
  lane: number;
  nodeTimeoutMs: number;
  valkey: string;
  nodes: number;
  durationMs: number;
  windowMs: number;
  healed: boolean;
  late: { p50: number; p99: number; max: number };
  lateOk: boolean;
  attempt: number;
  dropped: string[];
  host?: TrialMeta['host'];
  shown: Shown;
  cells: Cell[];
  seedOnly: SeedOnlyCell[];
}

export interface Shown {
  ticks: number;
  flagged: number;
  unanswered: number;
  split: number;
  longestSplitMs: number;
}

const FAILURE_FLAGS = ['fail', 'fail?'];

function story(raw: string): { text: string; flagged: boolean } {
  const lines = parseView(raw);
  const text = lines
    .map((line) => {
      const flags = line.flags.filter((flag) => flag !== 'myself').sort().join(',');
      const slots = line.slots.split(' ').filter((slot) => !slot.startsWith('[')).join(' ');
      return `${line.id} ${flags} ${line.primaryId} ${line.configEpoch} ${slots}`;
    })
    .sort()
    .join('\n');
  return { text, flagged: lines.some((line) => line.flags.some((flag) => FAILURE_FLAGS.includes(flag))) };
}

export function shownInViews(trace: Trace, seeds: string[], from: number, to: number): Shown {
  const shown: Shown = { ticks: 0, flagged: 0, unanswered: 0, split: 0, longestSplitMs: 0 };
  let run = 0;
  for (const tick of trace.ticks) {
    if (tick.t < from || tick.t > to) continue;
    shown.ticks += 1;
    const stories = seeds.map((seed) => {
      const sample = tick.nodes[seed];
      return sample?.ok ? story(sample.nodes) : null;
    });
    const answered = stories.filter((entry): entry is { text: string; flagged: boolean } => entry !== null);
    if (answered.length < stories.length) shown.unanswered += 1;
    if (answered.some((entry) => entry.flagged)) shown.flagged += 1;
    const split = new Set(answered.map((entry) => entry.text)).size > 1;
    if (split) shown.split += 1;
    run = split ? run + 1 : 0;
    shown.longestSplitMs = Math.max(shown.longestSplitMs, run * TICK_MS);
  }
  return shown;
}

export function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, min: sorted[0], p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] };
}

interface Outcome {
  seed: string;
  result: ReplayResult;
}

function cellOf(
  outcomes: Outcome[],
  window: { from: number; to: number; healedAt: number | null },
  faulted: ReadonlySet<string>,
): Omit<Cell, 'strategy' | 'minRounds' | 'variant' | 'vantage' | 'side'> {
  const cell = {
    replays: outcomes.length,
    raised: 0,
    critical: 0,
    early: 0,
    late: 0,
    ttd: null as Spread | null,
    kinds: {} as Record<string, number>,
    blame: { faulted: 0, healthy: 0, mixed: 0 },
    closed: null as Spread | null,
    stillOpen: 0,
    rounds: 0,
    comparable: 0,
    views: 0,
    reads: 0,
    bytes: 0,
    migrationChecks: 0,
  };
  const ttd: number[] = [];
  const closed: number[] = [];
  for (const { result } of outcomes) {
    cell.rounds += result.rounds;
    cell.comparable += result.comparable;
    cell.views += result.views;
    cell.reads += result.reads;
    cell.bytes += result.bytes;
    cell.migrationChecks += result.migrationChecks;
    if (result.events.some((event) => event.t < window.from)) cell.early += 1;
    const inside = result.events.filter((event) => event.t >= window.from && event.t <= window.to);
    if (inside.length === 0) {
      if (result.events.some((event) => event.t > window.to)) cell.late += 1;
      continue;
    }
    cell.raised += 1;
    if (inside.some((event) => event.severity === 'critical')) cell.critical += 1;
    const first = inside.filter((event) => event.t === inside[0].t);
    ttd.push(inside[0].t - window.from);
    const kinds = [...new Set(first.flatMap((event) => event.kinds))].sort().join('+');
    cell.kinds[kinds] = (cell.kinds[kinds] ?? 0) + 1;
    if (faulted.size > 0) {
      const dissent = [...new Set(first.flatMap((event) => event.dissent))];
      const hits = dissent.filter((name) => faulted.has(name)).length;
      if (hits === dissent.length) cell.blame.faulted += 1;
      else if (hits === 0) cell.blame.healthy += 1;
      else cell.blame.mixed += 1;
    }
    if (result.openAtEnd > 0) cell.stillOpen += 1;
    else if (result.lastCloseAt !== null) closed.push(result.lastCloseAt - (window.healedAt ?? window.from));
  }
  cell.ttd = spread(ttd);
  cell.closed = spread(closed);
  return cell;
}

export async function collectTrial(trace: Trace): Promise<TrialOutput> {
  const prepared = new PreparedTrace(trace);
  const { meta } = trace;
  const fault = meta.kind === 'fault';
  const window = {
    from: meta.t0,
    to: fault ? (meta.windowEnd ?? meta.end) : meta.end,
    healedAt: meta.windowEnd,
  };
  const faulted = new Set(meta.minority);
  const sides: Side[] = prepared.seeds.some((seed) => faulted.has(seed)) ? ['all', 'faulted', 'healthy'] : ['all'];
  const onSide = (side: Side, seed: string) => side === 'all' || (side === 'faulted') === faulted.has(seed);
  const vantages: Vantage[] = meta.cuts.length > 0 ? ['outside', 'inside'] : ['outside'];
  const variants = meta.scenario.includes('join') ? [DEFAULT_VARIANT, ...JOIN_VARIANTS] : [DEFAULT_VARIANT];
  const settings: JudgeSetting[] = variants.flatMap((variant) =>
    MIN_ROUNDS.map((minRounds) => ({ minRounds, variant })),
  );

  const cells: Cell[] = [];
  for (const strategy of STRATEGIES) {
    for (const vantage of vantages) {
      const outcomes: Outcome[][] = settings.map(() => []);
      for (const seed of prepared.seeds) {
        for (let phase = 0; phase < PHASES; phase++) {
          for (let draw = 0; draw < strategy.draws; draw++) {
            const results = await replay(prepared, { strategy, vantage, seed, phase, draw }, settings);
            results.forEach((result, index) => outcomes[index].push({ seed, result }));
          }
        }
      }
      settings.forEach((setting, index) => {
        for (const side of sides) {
          cells.push({
            strategy: strategy.name,
            minRounds: setting.minRounds,
            variant: setting.variant.name,
            vantage,
            side,
            ...cellOf(
              outcomes[index].filter((outcome) => onSide(side, outcome.seed)),
              window,
              faulted,
            ),
          });
        }
      });
    }
  }

  const seedCells: SeedOnlyCell[] = sides.map((side) => {
    const seeds = prepared.seeds.filter((seed) => onSide(side, seed));
    const results = seeds.map((seed) => seedOnly(prepared, seed, window.from, window.to));
    const times = (pick: (result: (typeof results)[number]) => number | null) =>
      results.map(pick).filter((t): t is number => t !== null).map((t) => t - window.from);
    const duplicate = times((result) => result.duplicatePrimaryAt);
    const stateFail = times((result) => result.clusterStateFailAt);
    return {
      side,
      seeds: seeds.length,
      duplicatePrimary: duplicate.length,
      duplicatePrimaryTtd: spread(duplicate),
      clusterStateFail: stateFail.length,
      clusterStateFailTtd: spread(stateFail),
      silent: results.filter((result) => result.silentTicks >= 3).length,
    };
  });

  return {
    trial: meta.trial,
    scenario: meta.scenario,
    kind: meta.kind,
    rep: meta.rep,
    lane: meta.lane,
    nodeTimeoutMs: meta.nodeTimeoutMs,
    valkey: meta.valkey,
    nodes: prepared.seeds.length,
    durationMs: meta.end,
    windowMs: window.to - window.from,
    healed: meta.windowEnd !== null,
    late: meta.late,
    lateOk: meta.lateOk ?? true,
    attempt: meta.attempt ?? 1,
    dropped: meta.dropped ?? [],
    host: meta.host,
    shown: shownInViews(trace, prepared.seeds, window.from, window.to),
    cells,
    seedOnly: seedCells,
  };
}
