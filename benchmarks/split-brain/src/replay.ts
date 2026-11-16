import { TICK_MS, hashSeed, mulberry32 } from './config';
import { Judge, type MigrationReader, parseSlotMigrationJobs } from './judge';
import {
  type ClusterNode,
  type DivergenceKind,
  MetricsParser,
  TopologyDivergenceMonitor,
  detectDuplicatePrimaries,
} from './product';
import type { Sample } from './recorder';
import type { TrialMeta } from './scenarios';
import type { Trace } from './trace';

export interface Strategy {
  name: string;
  nodesPerZone: number;
  randomNodes: number;
  zones: boolean;
  draws: number;
}

export const STRATEGIES: Strategy[] = [
  { name: 'random-1', nodesPerZone: 0, randomNodes: 1, zones: false, draws: 1 },
  { name: 'random-2', nodesPerZone: 0, randomNodes: 2, zones: false, draws: 3 },
  { name: 'random-3', nodesPerZone: 0, randomNodes: 3, zones: false, draws: 3 },
  { name: 'random-4', nodesPerZone: 0, randomNodes: 4, zones: false, draws: 3 },
  { name: 'random-5', nodesPerZone: 0, randomNodes: 5, zones: false, draws: 3 },
  { name: 'zone-1', nodesPerZone: 1, randomNodes: 3, zones: true, draws: 3 },
  { name: 'zone-2', nodesPerZone: 2, randomNodes: 3, zones: true, draws: 3 },
  { name: 'full', nodesPerZone: 99, randomNodes: 99, zones: true, draws: 1 },
];

export const MIN_ROUNDS = [2, 3, 5];
export const ROUND_INTERVAL_MS = 5_000;
export const PHASES = ROUND_INTERVAL_MS / TICK_MS;

export type Vantage = 'outside' | 'inside';

export interface Variant {
  name: string;
  kinds?: DivergenceKind[];
  membershipMinAgeMs: number;
}

export const DEFAULT_VARIANT: Variant = { name: 'as-shipped', membershipMinAgeMs: 60_000 };
export const JOIN_VARIANTS: Variant[] = [
  { name: 'membership-only-90s', kinds: ['membership'], membershipMinAgeMs: 90_000 },
  { name: 'without-membership', kinds: ['slot_owner', 'config_epoch', 'failure_flags'], membershipMinAgeMs: 60_000 },
];

export interface JudgeSetting {
  minRounds: number;
  variant: Variant;
}

export interface ReplayParams {
  strategy: Strategy;
  vantage: Vantage;
  seed: string;
  phase: number;
  draw: number;
}

export interface ReplayEvent {
  t: number;
  signature: string;
  severity: string;
  kinds: DivergenceKind[];
  dissent: string[];
  replaces: boolean;
}

export interface ReplayResult {
  rounds: number;
  comparable: number;
  views: number;
  reads: number;
  bytes: number;
  migrationChecks: number;
  events: ReplayEvent[];
  lastCloseAt: number | null;
  openAtEnd: number;
}

const BASE_AT = 1_000_000_000;

export class PreparedTrace {
  readonly meta: TrialMeta;
  readonly seeds: string[];
  private readonly ticks: Trace['ticks'];
  private readonly nameOfId = new Map<string, string>();
  private readonly zoneOfId = new Map<string, string>();
  private readonly parsed: Array<Map<string, ClusterNode[] | null>> = [];
  private readonly zoned: Array<Map<string, ClusterNode[]>> = [];

  constructor(trace: Trace) {
    this.meta = trace.meta;
    this.ticks = trace.ticks;
    this.seeds = trace.meta.nodes.filter((node) => node.role !== 'joiner').map((node) => node.name);
    for (const node of trace.meta.nodes) {
      this.nameOfId.set(node.id, node.name);
      this.zoneOfId.set(node.id, node.zone);
    }
  }

  get length(): number {
    return this.ticks.length;
  }

  timeOf(index: number): number {
    return this.ticks[index].t;
  }

  nameOf(id: string): string {
    return this.nameOfId.get(id) ?? id;
  }

  sample(index: number, name: string): Sample | undefined {
    return this.ticks[index].nodes[name];
  }

  view(index: number, name: string): ClusterNode[] | null {
    const cache = (this.parsed[index] ??= new Map());
    if (cache.has(name)) return cache.get(name) as ClusterNode[] | null;
    const sample = this.sample(index, name);
    const view = sample?.ok ? MetricsParser.parseClusterNodes(sample.nodes) : null;
    cache.set(name, view);
    return view;
  }

  zonedView(index: number, name: string): ClusterNode[] | null {
    const cache = (this.zoned[index] ??= new Map());
    const cached = cache.get(name);
    if (cached) return cached;
    const view = this.view(index, name);
    if (!view) return null;
    const zoned = view.map((node) => ({ ...node, availabilityZone: this.zoneOfId.get(node.id) }));
    cache.set(name, zoned);
    return zoned;
  }

  reachable(vantage: Vantage, seed: string, target: string, t: number): boolean {
    if (vantage === 'outside' || seed === target) return true;
    return !this.meta.cuts.some((cut) => {
      if (t < cut.from || (cut.to !== null && t > cut.to)) return false;
      return (cut.a.includes(seed) && cut.b.includes(target)) || (cut.b.includes(seed) && cut.a.includes(target));
    });
  }
}

async function replayOnce(
  trace: PreparedTrace,
  params: ReplayParams,
  settings: JudgeSetting[],
): Promise<ReplayResult[] | null> {
  const { strategy, vantage, seed } = params;
  const monitor = new TopologyDivergenceMonitor(
    mulberry32(hashSeed(trace.meta.trial, strategy.name, vantage, seed, params.phase, params.draw)),
  );
  let restarted = false;
  const restartable = {
    restart: (clusterKey: string, key: string) => {
      restarted = true;
      monitor.restart(clusterKey, key);
    },
  };
  const judges = settings.map(
    (setting) =>
      new Judge(restartable, {
        minRounds: setting.minRounds,
        nodeTimeoutMs: trace.meta.nodeTimeoutMs,
        membershipMinAgeMs: setting.variant.membershipMinAgeMs,
        kinds: setting.variant.kinds ? new Set(setting.variant.kinds) : undefined,
      }),
  );
  const cost = { rounds: 0, comparable: 0, views: 0, reads: 0, bytes: 0 };
  const results: ReplayResult[] = settings.map(() => ({
    ...cost,
    migrationChecks: 0,
    events: [],
    lastCloseAt: null,
    openAtEnd: 0,
  }));

  for (let index = params.phase; index < trace.length; index++) {
    const t = trace.timeOf(index);
    const own = strategy.zones ? trace.zonedView(index, seed) : trace.view(index, seed);
    if (!own) continue;
    const readable = (id: string): Sample | null => {
      const name = trace.nameOf(id);
      if (!trace.reachable(vantage, seed, name, t)) return null;
      const sample = trace.sample(index, name);
      return sample?.ok ? sample : null;
    };
    const round = await monitor.poll({
      clusterKey: 'bench',
      connectionId: 'seed',
      nodes: own,
      at: BASE_AT + t,
      intervalMs: ROUND_INTERVAL_MS,
      nodesPerZone: strategy.nodesPerZone,
      randomNodes: strategy.randomNodes,
      canRead: true,
      readView: async (node) => {
        cost.reads += 1;
        const sample = readable(node.id);
        if (!sample?.ok) return null;
        cost.bytes += sample.nodes.length;
        return trace.view(index, trace.nameOf(node.id));
      },
    });
    if (!round) continue;
    cost.rounds += 1;
    if (round.status === 'ok') cost.comparable += 1;
    cost.views += round.observers.length - round.unanswered.length;

    for (let j = 0; j < judges.length; j++) {
      const result = results[j];
      const readMigrations: MigrationReader = async (ownerId, seen) => {
        result.migrationChecks += 1;
        const sample = readable(ownerId);
        if (!sample?.ok) return null;
        const self =
          seen ?? trace.view(index, trace.nameOf(ownerId))?.find((node) => node.flags.includes('myself')) ?? null;
        return { self, jobs: parseSlotMigrationJobs(sample.migrations) };
      };
      const judged = await judges[j].observe(round, readMigrations);
      if (restarted && judges.length > 1) return null;
      for (const event of judged.raised) {
        result.events.push({
          t,
          signature: event.signature,
          severity: event.severity,
          kinds: event.kinds,
          dissent: event.dissent.map((id) => trace.nameOf(id)),
          replaces: event.replaces,
        });
      }
      if (judged.closed.length > 0) result.lastCloseAt = t;
      result.openAtEnd = judged.open.length;
    }
  }
  return results.map((result) => ({ ...result, ...cost }));
}

export async function replay(
  trace: PreparedTrace,
  params: ReplayParams,
  settings: JudgeSetting[],
): Promise<ReplayResult[]> {
  const shared = await replayOnce(trace, params, settings);
  if (shared) return shared;
  const separate: ReplayResult[] = [];
  for (const setting of settings) {
    separate.push(((await replayOnce(trace, params, [setting])) as ReplayResult[])[0]);
  }
  return separate;
}

export interface SeedOnlyResult {
  duplicatePrimaryAt: number | null;
  clusterStateFailAt: number | null;
  longestSilentTicks: number;
}

export function seedOnly(trace: PreparedTrace, seed: string, from: number, to: number): SeedOnlyResult {
  const result: SeedOnlyResult = { duplicatePrimaryAt: null, clusterStateFailAt: null, longestSilentTicks: 0 };
  let previousState: string | null = null;
  let silentRun = 0;
  for (let index = 0; index < trace.length; index++) {
    const t = trace.timeOf(index);
    const sample = trace.sample(index, seed);
    const inWindow = t >= from && t <= to;
    if (!sample?.ok) {
      silentRun = inWindow ? silentRun + 1 : 0;
      result.longestSilentTicks = Math.max(result.longestSilentTicks, silentRun);
      continue;
    }
    silentRun = 0;
    if (inWindow) {
      const view = trace.view(index, seed) as ClusterNode[];
      if (result.duplicatePrimaryAt === null && detectDuplicatePrimaries(view).length > 0) {
        result.duplicatePrimaryAt = t;
      }
      if (result.clusterStateFailAt === null && previousState === 'ok' && sample.info.state === 'fail') {
        result.clusterStateFailAt = t;
      }
    }
    previousState = sample.info.state;
  }
  return result;
}
