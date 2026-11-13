import type { ClusterNodeState } from '@betterdb/shared';
import type { SlotLoadRate } from '@app/cluster/shard-load';
import { median } from '../latency-regression/regression-detector';
import { hotShardRatio } from './hot-shard-detector';
import { type HotShardKey, displayKeyName } from './hot-shard-keys';

export const REBALANCE_REFRESH_MS = 5 * 60_000;

export interface RebalancePolicy {
  pinnedSlotShare: number;
  nodeCpuLimitUsecPerSecond: number;
  resolveRatio: number;
  headroomShare: number;
  maxRanges: number;
  maxTargets: number;
  targetMemoryShare: number;
  excludedShardIds: readonly string[];
  excludedSlots: readonly number[];
}

export const DEFAULT_REBALANCE_POLICY: RebalancePolicy = {
  pinnedSlotShare: 0.2,
  nodeCpuLimitUsecPerSecond: 800_000,
  resolveRatio: 1.25,
  headroomShare: 0.25,
  maxRanges: 8,
  maxTargets: 4,
  targetMemoryShare: 0.8,
  excludedShardIds: [],
  excludedSlots: [],
};

export interface RebalanceShard {
  shardId: string;
  nodeAddr: string;
  cpuUsecPerSecond: number;
  slotCount: number;
  state: ClusterNodeState;
  hot: boolean;
  replicaCount?: number;
  availabilityZone?: string;
}

export interface RebalanceInput {
  hotShardId: string;
  shards: readonly RebalanceShard[];
  slots: readonly SlotLoadRate[];
}

export type RebalanceNoPlanReason =
  | 'key_level'
  | 'cluster_hot'
  | 'no_target'
  | 'unhealthy_node'
  | 'migration_running'
  | 'settling'
  | 'slots_scattered'
  | 'too_many_targets'
  | 'covered_by_other_plan'
  | 'conflicts_with_other_plan';

export interface RebalanceCoveringShard {
  shardId: string;
  nodeAddr: string;
}

export interface RebalancePinnedSlot {
  slot: number;
  shareOfShard: number;
}

export interface RebalanceMove {
  targetShardId: string;
  targetAddr: string;
  ranges: Array<[number, number]>;
  slotCount: number;
  keyCount: number;
  cpuUsecPerSecond: number;
  shareOfShard: number;
}

export interface RebalanceShardLoad {
  cpuUsecPerSecond: number;
  share: number;
  ratio: number;
}

export interface RebalanceProjection {
  shardId: string;
  nodeAddr: string;
  role: 'source' | 'target' | 'other';
  before: RebalanceShardLoad;
  after: RebalanceShardLoad;
}

export interface RebalanceWarning {
  code: 'source_fork' | 'fewer_replicas' | 'target_memory' | 'memory_unknown';
  shardId: string;
  memoryShare?: number;
}

export type RebalanceSupport =
  | 'valkey_atomic'
  | 'redis_atomic'
  | 'none'
  | 'provider_managed'
  | 'unknown';

export interface ShardServer {
  dbType: 'valkey' | 'redis';
  version: string;
}

export interface RebalanceCommand {
  nodeAddr: string;
  text: string;
}

export interface ShardMemory {
  usedBytes: number;
  maxBytes: number;
  keyCount: number;
}

export interface RebalancePlan {
  kind: 'plan';
  action: 'spread';
  effect: 'resolves' | 'headroom';
  sourceShardId: string;
  moves: RebalanceMove[];
  pinnedSlots: RebalancePinnedSlot[];
  projection: RebalanceProjection[];
  medianBefore: number;
  medianAfter: number;
  warnings: RebalanceWarning[];
  plannedAfter: string[];
  support?: RebalanceSupport;
  commands?: RebalanceCommand[];
}

export interface RebalanceNoPlan {
  kind: 'no_plan';
  action: 'spread';
  reason: RebalanceNoPlanReason;
  pinnedSlots: RebalancePinnedSlot[];
  coveredBy?: RebalanceCoveringShard[];
  conflictsWith?: RebalanceCoveringShard[];
}

export type RebalanceVerdict = RebalancePlan | RebalanceNoPlan;

const SOLVE_STEPS = 50;
const SLACK = 1e-6;
const AIM_STEPS = 6;
const HEAVY_ROUNDS = 8;
const TRIM_STEPS = 256;

interface SlotWindow {
  slots: SlotLoadRate[];
  cpu: number;
  keys: number;
}

interface Outlook {
  sourceRatio: number;
  targetsFit: boolean;
}

interface Taker {
  target: RebalanceShard;
  fill: number;
  slots: SlotLoadRate[];
  cpu: number;
}

interface Realized {
  takers: Taker[];
  selected: number;
  freed: number;
  medianAfter: number;
  sourceRatio: number;
  oversized: SlotLoadRate[];
}

export function noRebalancePlan(
  reason: RebalanceNoPlanReason,
  pinnedSlots: RebalancePinnedSlot[] = [],
): RebalanceNoPlan {
  return { kind: 'no_plan', action: 'spread', reason, pinnedSlots };
}

const TRANSIENT_NO_PLAN_REASONS: readonly RebalanceNoPlanReason[] = [
  'migration_running',
  'settling',
];

export function isTransientNoPlan(verdict: RebalanceVerdict): boolean {
  return verdict.kind === 'no_plan' && TRANSIENT_NO_PLAN_REASONS.includes(verdict.reason);
}

function cpuOf(slots: readonly SlotLoadRate[]): number {
  return slots.reduce((total, slot) => total + slot.cpuUsecPerSecond, 0);
}

function keysOf(slots: readonly SlotLoadRate[]): number {
  return slots.reduce((total, slot) => total + slot.keyCount, 0);
}

function waterFill(levels: readonly number[], amount: number): number[] {
  const fills = levels.map(() => 0);
  let remaining = amount;
  for (let count = 1; count <= levels.length && remaining > 0; count += 1) {
    const level = levels[count - 1] + fills[count - 1];
    const next = count < levels.length ? levels[count] : Infinity;
    const step = Math.min(remaining / count, next - level);
    for (let i = 0; i < count; i += 1) fills[i] += step;
    remaining -= step * count;
  }
  return fills;
}

function edgeThat(
  holds: (amount: number) => boolean,
  most: number,
  edge: 'smallest' | 'largest',
): number {
  const fromAbove = edge === 'smallest';
  let low = 0;
  let high = most;
  for (let step = 0; step < SOLVE_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (holds(middle) === fromAbove) high = middle;
    else low = middle;
  }
  return fromAbove ? high : low;
}

function pinnedSlotsOf(kept: readonly SlotLoadRate[], sourceCpu: number): RebalancePinnedSlot[] {
  return [...kept]
    .sort((a, b) => b.cpuUsecPerSecond - a.cpuUsecPerSecond || a.slot - b.slot)
    .map((slot) => ({ slot: slot.slot, shareOfShard: slot.cpuUsecPerSecond / sourceCpu }));
}

function segmentsOf(slots: readonly SlotLoadRate[]): SlotLoadRate[][] {
  const segments: SlotLoadRate[][] = [];
  for (const slot of slots) {
    const last = segments[segments.length - 1];
    if (last && last[last.length - 1].slot === slot.slot - 1) last.push(slot);
    else segments.push([slot]);
  }
  return segments;
}

function cheapestWindow(segments: readonly SlotLoadRate[][], need: number): SlotWindow | null {
  let best: SlotWindow | null = null;
  for (const segment of segments) {
    let cpu = 0;
    let keys = 0;
    let left = 0;
    for (let right = 0; right < segment.length; right += 1) {
      cpu += segment[right].cpuUsecPerSecond;
      keys += segment[right].keyCount;
      while (left < right && cpu - segment[left].cpuUsecPerSecond >= need - SLACK) {
        cpu -= segment[left].cpuUsecPerSecond;
        keys -= segment[left].keyCount;
        left += 1;
      }
      if (cpu < need - SLACK) continue;
      const size = right - left + 1;
      if (best && (keys > best.keys || (keys === best.keys && size >= best.slots.length))) continue;
      best = { slots: segment.slice(left, right + 1), cpu, keys };
    }
  }
  return best;
}

function selectWindows(
  movable: readonly SlotLoadRate[],
  need: number,
  maxWindows: number,
): SlotWindow[] {
  const segments = segmentsOf(movable);
  const chosen: SlotWindow[] = [];
  let remaining = need;
  while (chosen.length < maxWindows && remaining > SLACK) {
    const window = cheapestWindow(segments, remaining);
    if (window) {
      chosen.push(window);
      break;
    }
    let largest = -1;
    let largestCpu = 0;
    segments.forEach((segment, index) => {
      const cpu = cpuOf(segment);
      if (cpu > largestCpu) {
        largest = index;
        largestCpu = cpu;
      }
    });
    if (largest < 0) break;
    const [segment] = segments.splice(largest, 1);
    chosen.push({ slots: segment, cpu: largestCpu, keys: keysOf(segment) });
    remaining -= largestCpu;
  }
  return chosen;
}

function rangesOf(slots: readonly SlotLoadRate[]): Array<[number, number]> {
  return segmentsOf(slots).map((segment) => [segment[0].slot, segment[segment.length - 1].slot]);
}

function pour(
  windows: readonly SlotWindow[],
  targets: readonly RebalanceShard[],
  fills: readonly number[],
): Taker[] {
  const takers = targets
    .map((target, index): Taker => ({ target, fill: fills[index], slots: [], cpu: 0 }))
    .filter((taker) => taker.fill > SLACK);
  if (takers.length === 0) return [];
  const ordered = windows.flatMap((window) => window.slots).sort((a, b) => a.slot - b.slot);
  let at = 0;
  let due = takers[0].fill;
  let poured = 0;
  for (const slot of ordered) {
    while (at < takers.length - 1 && poured + slot.cpuUsecPerSecond / 2 > due + SLACK) {
      at += 1;
      due += takers[at].fill;
    }
    takers[at].slots.push(slot);
    takers[at].cpu += slot.cpuUsecPerSecond;
    poured += slot.cpuUsecPerSecond;
  }
  return takers;
}

function dropEdge(taker: Taker, all: boolean): void {
  if (all) {
    taker.slots = [];
  } else if (
    taker.slots[0].cpuUsecPerSecond > taker.slots[taker.slots.length - 1].cpuUsecPerSecond
  ) {
    taker.slots.shift();
  } else {
    taker.slots.pop();
  }
  taker.cpu = cpuOf(taker.slots);
}

interface Spread {
  input: RebalanceInput;
  policy: RebalancePolicy;
  source: RebalanceShard;
  sourceCpu: number;
  medianBefore: number;
  candidates: RebalanceShard[];
  kept: SlotLoadRate[];
  reportOversized: boolean;
}

function spread(ctx: Spread): RebalanceVerdict | SlotLoadRate[] {
  const { input, policy, source, sourceCpu, medianBefore, candidates } = ctx;
  const pinnedSlots = pinnedSlotsOf(ctx.kept, sourceCpu);
  const kept = new Set([...ctx.kept.map((slot) => slot.slot), ...policy.excludedSlots]);
  const movable = input.slots
    .filter((slot) => !kept.has(slot.slot))
    .sort((a, b) => a.slot - b.slot);
  const movableCpu = cpuOf(movable);
  const owners = input.shards.filter((shard) => shard === source || shard.slotCount > 0);
  const cpuBefore = (shard: RebalanceShard) =>
    shard === source ? sourceCpu : shard.cpuUsecPerSecond;
  const fitsOn = (cpu: number, medianAfter: number, slack = 0) =>
    cpu <= policy.nodeCpuLimitUsecPerSecond + slack &&
    hotShardRatio(cpu, medianAfter) <= policy.resolveRatio + slack;

  const outlook = (targets: readonly RebalanceShard[], amount: number): Outlook => {
    const fills = waterFill(
      targets.map((target) => target.cpuUsecPerSecond),
      amount,
    );
    const after = targets.map((target, index) => target.cpuUsecPerSecond + fills[index]);
    const medianAfter = median([
      ...owners
        .filter((shard) => shard !== source && !targets.includes(shard))
        .map((shard) => shard.cpuUsecPerSecond),
      sourceCpu - amount,
      ...after.filter((_, index) => targets[index].slotCount > 0 || fills[index] > 0),
    ]);
    return {
      sourceRatio: hotShardRatio(sourceCpu - amount, medianAfter),
      targetsFit: after.every((cpu, index) => fills[index] <= 0 || fitsOn(cpu, medianAfter)),
    };
  };

  const loadsAfter = (takers: readonly Taker[]) => {
    const gained = new Map(
      takers
        .filter((taker) => taker.slots.length > 0)
        .map((taker) => [taker.target.shardId, taker.cpu]),
    );
    const freed = [...gained.values()].reduce((total, cpu) => total + cpu, 0);
    const cpuAfter = (shard: RebalanceShard) =>
      shard === source
        ? sourceCpu - freed
        : shard.cpuUsecPerSecond + (gained.get(shard.shardId) ?? 0);
    const medianAfter = median(
      input.shards
        .filter((shard) => owners.includes(shard) || gained.has(shard.shardId))
        .map(cpuAfter),
    );
    return { gained, freed, cpuAfter, medianAfter };
  };

  const trim = (takers: readonly Taker[]): void => {
    for (let step = 0; ; step += 1) {
      const { medianAfter } = loadsAfter(takers);
      const after = (taker: Taker) => taker.target.cpuUsecPerSecond + taker.cpu;
      const worst = takers
        .filter((taker) => taker.slots.length > 0)
        .reduce<
          Taker | undefined
        >((top, taker) => (top && after(top) >= after(taker) ? top : taker), undefined);
      if (!worst || fitsOn(after(worst), medianAfter, SLACK)) return;
      dropEdge(worst, step >= TRIM_STEPS);
    }
  };

  const realize = (targets: readonly RebalanceShard[], aim: number): Realized => {
    const windows = selectWindows(
      movable,
      aim,
      Math.max(1, policy.maxRanges - (targets.length - 1)),
    );
    const selected = windows.reduce((total, window) => total + window.cpu, 0);
    const fills = waterFill(
      targets.map((target) => target.cpuUsecPerSecond),
      selected,
    );
    const largestFill = Math.max(...fills);
    const oversized = ctx.reportOversized
      ? windows
          .flatMap((window) => window.slots)
          .filter((slot) => slot.cpuUsecPerSecond > largestFill + SLACK)
      : [];
    const takers = pour(windows, targets, fills);
    trim(takers);
    const { freed, medianAfter } = loadsAfter(takers);
    return {
      takers,
      selected,
      freed,
      medianAfter,
      sourceRatio: hotShardRatio(sourceCpu - freed, medianAfter),
      oversized,
    };
  };

  const most = Math.max(1, Math.min(policy.maxTargets, policy.maxRanges, candidates.length));
  let chosen: Realized | undefined;
  for (let count = 1; count <= most && !chosen; count += 1) {
    const tried = candidates.slice(0, count);
    const resolves = (moved: number) => outlook(tried, moved).sourceRatio <= policy.resolveRatio;
    if (!resolves(movableCpu)) continue;
    const needed = edgeThat(resolves, movableCpu, 'smallest');
    if (!outlook(tried, needed).targetsFit) continue;
    let aim = needed;
    for (let step = 0; step < AIM_STEPS; step += 1) {
      const real = realize(tried, aim);
      if (real.freed > 0 && real.sourceRatio <= policy.resolveRatio + SLACK) {
        chosen = real;
        break;
      }
      if (real.oversized.length > 0) return real.oversized;
      if (real.selected >= movableCpu - SLACK) break;
      const short = sourceCpu - real.freed - policy.resolveRatio * real.medianAfter;
      aim = Math.min(movableCpu, real.selected + Math.max(short, 2 * SLACK));
    }
  }
  if (!chosen) {
    const roomOf = (pool: readonly RebalanceShard[]) => {
      const fits = (moved: number) => outlook(pool, moved).targetsFit;
      return fits(movableCpu) ? movableCpu : edgeThat(fits, movableCpu, 'largest');
    };
    const enough = policy.headroomShare * sourceCpu - SLACK;
    const pool = candidates.slice(0, most);
    const amount = roomOf(pool);
    if (amount < enough) {
      if (movableCpu < enough) return noRebalancePlan('key_level', pinnedSlots);
      return noRebalancePlan(
        roomOf(candidates) < enough ? 'cluster_hot' : 'too_many_targets',
        pinnedSlots,
      );
    }
    chosen = realize(pool, amount);
    if (chosen.oversized.length > 0 && chosen.freed < enough) return chosen.oversized;
  }

  const takers = chosen.takers.filter((taker) => taker.slots.length > 0);
  const { gained, freed, cpuAfter, medianAfter } = loadsAfter(takers);
  const effect =
    hotShardRatio(sourceCpu - freed, medianAfter) <= policy.resolveRatio + SLACK
      ? 'resolves'
      : 'headroom';
  if (
    takers.length === 0 ||
    (effect === 'headroom' && freed < policy.headroomShare * sourceCpu - SLACK)
  ) {
    return noRebalancePlan('slots_scattered', pinnedSlots);
  }
  const moves = takers.map(
    ({ target, slots, cpu }): RebalanceMove => ({
      targetShardId: target.shardId,
      targetAddr: target.nodeAddr,
      ranges: rangesOf(slots),
      slotCount: slots.length,
      keyCount: keysOf(slots),
      cpuUsecPerSecond: cpu,
      shareOfShard: cpu / sourceCpu,
    }),
  );

  const totalCpu = input.shards.reduce((total, shard) => total + cpuBefore(shard), 0);
  const order = (shard: RebalanceShard) =>
    shard === source ? 0 : gained.has(shard.shardId) ? 1 : 2;
  const projection = [...input.shards]
    .sort((a, b) => order(a) - order(b))
    .map(
      (shard): RebalanceProjection => ({
        shardId: shard.shardId,
        nodeAddr: shard.nodeAddr,
        role: (['source', 'target', 'other'] as const)[order(shard)],
        before: {
          cpuUsecPerSecond: cpuBefore(shard),
          share: cpuBefore(shard) / totalCpu,
          ratio: hotShardRatio(cpuBefore(shard), medianBefore),
        },
        after: {
          cpuUsecPerSecond: cpuAfter(shard),
          share: cpuAfter(shard) / totalCpu,
          ratio: hotShardRatio(cpuAfter(shard), medianAfter),
        },
      }),
    );

  const warnings: RebalanceWarning[] = [{ code: 'source_fork', shardId: source.shardId }];
  for (const { target } of takers) {
    if (target.replicaCount === undefined || source.replicaCount === undefined) continue;
    if (target.replicaCount < source.replicaCount) {
      warnings.push({ code: 'fewer_replicas', shardId: target.shardId });
    }
  }

  return {
    kind: 'plan',
    action: 'spread',
    effect,
    sourceShardId: source.shardId,
    moves,
    pinnedSlots,
    projection,
    medianBefore,
    medianAfter,
    warnings,
    plannedAfter: [],
  };
}

function medianOfOwners(
  shards: readonly RebalanceShard[],
  source: RebalanceShard,
  sourceCpu: number,
): number {
  return median(
    shards
      .filter((shard) => shard === source || shard.slotCount > 0)
      .map((shard) => (shard === source ? sourceCpu : shard.cpuUsecPerSecond)),
  );
}

function isOverTheLine(input: RebalanceInput, policy: RebalancePolicy): boolean {
  const source = input.shards.find((shard) => shard.shardId === input.hotShardId);
  const sourceCpu = cpuOf(input.slots);
  if (!source || sourceCpu <= 0) return false;
  const measured = medianOfOwners(input.shards, source, sourceCpu);
  return hotShardRatio(sourceCpu, measured) > policy.resolveRatio;
}

export function planRebalance(
  input: RebalanceInput,
  policy: RebalancePolicy = DEFAULT_REBALANCE_POLICY,
): RebalanceVerdict {
  if (input.shards.some((shard) => shard.state !== 'healthy' && shard.slotCount > 0)) {
    return noRebalancePlan('unhealthy_node');
  }
  const source = input.shards.find((shard) => shard.shardId === input.hotShardId);
  const sourceCpu = cpuOf(input.slots);
  if (!source || sourceCpu <= 0) return noRebalancePlan('settling');

  const medianBefore = medianOfOwners(input.shards, source, sourceCpu);
  if (hotShardRatio(sourceCpu, medianBefore) <= policy.resolveRatio) {
    return noRebalancePlan('settling');
  }

  const pinned = input.slots.filter(
    (slot) => slot.cpuUsecPerSecond >= policy.pinnedSlotShare * sourceCpu,
  );
  if (cpuOf(pinned) >= policy.nodeCpuLimitUsecPerSecond) {
    return noRebalancePlan('key_level', pinnedSlotsOf(pinned, sourceCpu));
  }

  const sameZone = (shard: RebalanceShard) =>
    source.availabilityZone !== undefined && shard.availabilityZone === source.availabilityZone
      ? 0
      : 1;
  const candidates = input.shards
    .filter(
      (shard) =>
        shard !== source &&
        !shard.hot &&
        shard.state === 'healthy' &&
        !policy.excludedShardIds.includes(shard.shardId),
    )
    .sort(
      (a, b) =>
        a.cpuUsecPerSecond - b.cpuUsecPerSecond ||
        sameZone(a) - sameZone(b) ||
        (a.shardId < b.shardId ? -1 : 1),
    );
  if (candidates.length === 0) {
    return noRebalancePlan('no_target', pinnedSlotsOf(pinned, sourceCpu));
  }

  const kept = [...pinned];
  for (let round = 0; ; round += 1) {
    const outcome = spread({
      input,
      policy,
      source,
      sourceCpu,
      medianBefore,
      candidates,
      kept,
      reportOversized: round < HEAVY_ROUNDS,
    });
    if (!Array.isArray(outcome)) return outcome;
    kept.push(...outcome);
  }
}

export function planRebalances(
  hotShards: ReadonlyArray<Omit<RebalanceInput, 'shards'>>,
  shards: readonly RebalanceShard[],
  earlier: readonly RebalanceVerdict[] = [],
  policy: RebalancePolicy = DEFAULT_REBALANCE_POLICY,
): RebalanceVerdict[] {
  const verdicts: RebalanceVerdict[] = [];
  for (const hotShard of hotShards) {
    const counted = [...earlier, ...verdicts].filter((verdict) => verdict.kind === 'plan');
    const left = shardsAfter(shards, counted);
    const named = (plans: readonly RebalancePlan[]) =>
      plans.map((plan) => ({
        shardId: plan.sourceShardId,
        nodeAddr:
          shards.find((shard) => shard.shardId === plan.sourceShardId)?.nodeAddr ??
          plan.sourceShardId,
      }));
    const conflict = (candidate: RebalancePlan): RebalanceVerdict => ({
      ...noRebalancePlan('conflicts_with_other_plan'),
      conflictsWith: named(plansInTheWay(shards, counted, candidate, policy)),
    });
    const fits = (candidate: RebalanceVerdict): candidate is RebalancePlan =>
      candidate.kind === 'plan' && holdTogether(shards, counted, candidate, policy);
    const verdict = planRebalance({ ...hotShard, shards: left }, policy);
    if (verdict.kind === 'plan') {
      const fitting = fits(verdict)
        ? verdict
        : planRebalance(
            { ...hotShard, shards: left },
            {
              ...policy,
              excludedShardIds: [
                ...policy.excludedShardIds,
                ...left.filter((shard) => shard.slotCount === 0).map((shard) => shard.shardId),
              ],
            },
          );
      verdicts.push(
        fits(fitting)
          ? { ...fitting, plannedAfter: counted.map((plan) => plan.sourceShardId) }
          : conflict(verdict),
      );
    } else if (counted.length === 0) {
      verdicts.push(verdict);
    } else if (verdict.reason === 'settling' && isOverTheLine({ ...hotShard, shards }, policy)) {
      verdicts.push({ ...noRebalancePlan('covered_by_other_plan'), coveredBy: named(counted) });
    } else {
      const alone = planRebalance({ ...hotShard, shards }, policy);
      verdicts.push(alone.kind === 'plan' ? conflict(alone) : alone);
    }
  }
  return verdicts;
}

function plansInTheWay(
  shards: readonly RebalanceShard[],
  earlier: readonly RebalancePlan[],
  candidate: RebalancePlan,
  policy: RebalancePolicy,
): readonly RebalancePlan[] {
  const already = new Set(shardsOverTheLine(shards, earlier, policy));
  const pushed = new Set(
    shardsOverTheLine(shards, [...earlier, candidate], policy).filter(
      (shardId) => !already.has(shardId),
    ),
  );
  const shared = new Set(candidate.moves.map((move) => move.targetShardId));
  const touching = (shardIds: ReadonlySet<string>) =>
    earlier.filter(
      (plan) =>
        shardIds.has(plan.sourceShardId) ||
        plan.moves.some((move) => shardIds.has(move.targetShardId)),
    );
  return [touching(pushed), touching(shared), earlier].find((plans) => plans.length > 0) ?? earlier;
}

function holdTogether(
  shards: readonly RebalanceShard[],
  earlier: readonly RebalancePlan[],
  latest: RebalancePlan,
  policy: RebalancePolicy,
): boolean {
  if (earlier.length === 0) return true;
  const already = new Set(shardsOverTheLine(shards, earlier, policy));
  return shardsOverTheLine(shards, [...earlier, latest], policy).every((shardId) =>
    already.has(shardId),
  );
}

function shardsOverTheLine(
  shards: readonly RebalanceShard[],
  plans: readonly RebalancePlan[],
  policy: RebalancePolicy,
): string[] {
  const after = shardsAfter(shards, plans);
  const cpuByShard = new Map(after.map((shard) => [shard.shardId, shard.cpuUsecPerSecond]));
  const sources = new Set(plans.map((plan) => plan.sourceShardId));
  const medianAfter = median(
    after
      .filter((shard) => shard.slotCount > 0 || sources.has(shard.shardId))
      .map((shard) => shard.cpuUsecPerSecond),
  );
  return plans
    .flatMap((plan) => [
      ...plan.moves.map((move) => move.targetShardId),
      ...(plan.effect === 'resolves' ? [plan.sourceShardId] : []),
    ])
    .filter(
      (shardId) =>
        hotShardRatio(cpuByShard.get(shardId) ?? 0, medianAfter) > policy.resolveRatio + SLACK,
    );
}

function shardsAfter(
  shards: readonly RebalanceShard[],
  plans: readonly RebalancePlan[],
): RebalanceShard[] {
  const change = new Map<string, { cpu: number; slots: number }>();
  const add = (shardId: string, cpu: number, slots: number) => {
    const last = change.get(shardId) ?? { cpu: 0, slots: 0 };
    change.set(shardId, { cpu: last.cpu + cpu, slots: last.slots + slots });
  };
  for (const plan of plans) {
    for (const move of plan.moves) {
      add(move.targetShardId, move.cpuUsecPerSecond, move.slotCount);
      add(plan.sourceShardId, -move.cpuUsecPerSecond, -move.slotCount);
    }
  }
  return shards.map((shard) => {
    const moved = change.get(shard.shardId) ?? { cpu: 0, slots: 0 };
    return {
      ...shard,
      cpuUsecPerSecond: Math.max(0, shard.cpuUsecPerSecond + moved.cpu),
      slotCount: Math.max(0, shard.slotCount + moved.slots),
    };
  });
}

export function shardMemoryFromInfo(
  info: Record<string, Record<string, string> | undefined>,
): ShardMemory | undefined {
  const usedBytes = Number(info.memory?.used_memory);
  const maxBytes = Number(info.memory?.maxmemory);
  if (!Number.isFinite(usedBytes) || !Number.isFinite(maxBytes)) return undefined;
  const keyCount = Object.values(info.keyspace ?? {}).reduce((total, db) => {
    const keys = Number(/(?:^|,)keys=(\d+)/.exec(db)?.[1]);
    return total + (Number.isFinite(keys) ? keys : 0);
  }, 0);
  return { usedBytes, maxBytes, keyCount };
}

export function memoryWarnings(
  plan: RebalancePlan,
  memoryByShard: ReadonlyMap<string, ShardMemory>,
  earlier: readonly RebalancePlan[] = [],
  policy: RebalancePolicy = DEFAULT_REBALANCE_POLICY,
): RebalanceWarning[] {
  return plan.moves.flatMap((move): RebalanceWarning[] => {
    const target = memoryByShard.get(move.targetShardId);
    const arriving = [plan, ...earlier].flatMap((from) => {
      const source = memoryByShard.get(from.sourceShardId);
      return from.moves
        .filter((other) => other.targetShardId === move.targetShardId)
        .map((other) =>
          source && source.keyCount > 0
            ? (other.keyCount * source.usedBytes) / source.keyCount
            : undefined,
        );
    });
    if (!target || target.maxBytes <= 0 || arriving.includes(undefined)) {
      return [{ code: 'memory_unknown', shardId: move.targetShardId }];
    }
    const bytes = arriving.reduce<number>((total, each) => total + (each ?? 0), 0);
    const memoryShare = (target.usedBytes + bytes) / target.maxBytes;
    return memoryShare > policy.targetMemoryShare
      ? [{ code: 'target_memory', shardId: move.targetShardId, memoryShare }]
      : [];
  });
}

export function shardServerFromInfo(
  info: Record<string, Record<string, string> | undefined>,
): ShardServer | undefined {
  const server = info.server;
  if (server?.valkey_version) return { dbType: 'valkey', version: server.valkey_version };
  if (server?.redis_version) return { dbType: 'redis', version: server.redis_version };
  return undefined;
}

const ATOMIC_MIGRATION_SINCE: Record<ShardServer['dbType'], [number, number]> = {
  valkey: [9, 0],
  redis: [8, 4],
};

function atomicMigration(server: ShardServer): boolean | undefined {
  const [major, minor] = server.version.split('.').map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return undefined;
  const [sinceMajor, sinceMinor] = ATOMIC_MIGRATION_SINCE[server.dbType];
  return major > sinceMajor || (major === sinceMajor && minor >= sinceMinor);
}

function supportOf(
  servers: ReadonlyArray<ShardServer | undefined>,
  providerManaged: boolean,
): RebalanceSupport {
  if (providerManaged) return 'provider_managed';
  const atomic = servers.map((server) => server && atomicMigration(server));
  if (atomic.some((known) => known === undefined)) return 'unknown';
  const dbType = servers[0]?.dbType;
  if (atomic.some((able) => !able) || servers.some((server) => server?.dbType !== dbType)) {
    return 'none';
  }
  return dbType === 'valkey' ? 'valkey_atomic' : 'redis_atomic';
}

const rangeArgs = (ranges: ReadonlyArray<[number, number]>) =>
  ranges.map(([start, end]) => `${start} ${end}`).join(' ');

function commandsOf(plan: RebalancePlan, support: RebalanceSupport): RebalanceCommand[] {
  if (support === 'valkey_atomic') {
    const source = plan.projection.find((row) => row.role === 'source');
    if (!source) return [];
    const blocks = plan.moves.map(
      (move) => `SLOTSRANGE ${rangeArgs(move.ranges)} NODE ${move.targetShardId}`,
    );
    return [{ nodeAddr: source.nodeAddr, text: `CLUSTER MIGRATESLOTS ${blocks.join(' ')}` }];
  }
  if (support === 'redis_atomic') {
    return plan.moves.map((move) => ({
      nodeAddr: move.targetAddr,
      text: `CLUSTER MIGRATION IMPORT ${rangeArgs(move.ranges)}`,
    }));
  }
  return [];
}

export function withCommands(
  plan: RebalancePlan,
  serverByShard: ReadonlyMap<string, ShardServer>,
  providerManaged: boolean,
): RebalancePlan {
  const shardIds = [plan.sourceShardId, ...plan.moves.map((move) => move.targetShardId)];
  const support = supportOf(
    shardIds.map((shardId) => serverByShard.get(shardId)),
    providerManaged,
  );
  return { ...plan, support, commands: commandsOf(plan, support) };
}

function listed(values: readonly (number | string)[]): string {
  if (values.length < 2) return values.join('');
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

function describeKeyLevel(
  pinnedSlots: readonly RebalancePinnedSlot[],
  topKeys: readonly HotShardKey[],
): string {
  const share = Math.round(pinnedSlots.reduce((total, slot) => total + slot.shareOfShard, 0) * 100);
  const slots = pinnedSlots.map((slot) => slot.slot);
  const load =
    slots.length === 0
      ? "the slots that can move carry too little of this shard's CPU"
      : slots.length === 1
        ? `slot ${slots[0]} alone is ${share}% of this shard's CPU`
        : `slots ${listed(slots)} are ${share}% of this shard's CPU`;
  const key = slots.length === 1 ? topKeys.find((top) => top.slot === slots[0]) : undefined;
  const target = key
    ? `key "${displayKeyName(key.key)}"`
    : slots.length === 1
      ? 'the hot key'
      : 'the hot keys';
  return (
    ` Rebalancing will not help: ${load}. ` +
    `Consider client-side caching, reads from replicas, or splitting ${target}.`
  );
}

const NO_PLAN_SENTENCES: Partial<Record<RebalanceNoPlanReason, string>> = {
  cluster_hot:
    ' Rebalancing will not help: no other shard has room for this load. Consider adding a shard.',
  no_target: ' No rebalance is suggested: no other primary can take slots.',
  too_many_targets:
    ' No rebalance is suggested: this load would have to be spread over too many shards.',
  slots_scattered:
    " No rebalance is suggested: this shard's slots are too scattered to move enough load in a few ranges.",
};

export function describeNoPlan(
  verdict: RebalanceVerdict | undefined,
  topKeys: readonly HotShardKey[],
): string {
  if (!verdict || verdict.kind === 'plan') return '';
  if (verdict.reason === 'key_level') return describeKeyLevel(verdict.pinnedSlots, topKeys);
  return NO_PLAN_SENTENCES[verdict.reason] ?? '';
}
