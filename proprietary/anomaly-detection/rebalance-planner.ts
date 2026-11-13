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
  | 'slots_scattered';

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
}

export interface RebalanceNoPlan {
  kind: 'no_plan';
  action: 'spread';
  reason: RebalanceNoPlanReason;
  pinnedSlots: RebalancePinnedSlot[];
}

export type RebalanceVerdict = RebalancePlan | RebalanceNoPlan;

const SOLVE_STEPS = 50;
const SLACK = 1e-6;

interface SlotWindow {
  slots: SlotLoadRate[];
  cpu: number;
  keys: number;
}

interface Outlook {
  fills: number[];
  sourceRatio: number;
  targetsFit: boolean;
}

export function noRebalancePlan(
  reason: RebalanceNoPlanReason,
  pinnedSlots: RebalancePinnedSlot[] = [],
): RebalanceNoPlan {
  return { kind: 'no_plan', action: 'spread', reason, pinnedSlots };
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

function smallestThat(holds: (amount: number) => boolean, most: number): number {
  let low = 0;
  let high = most;
  for (let step = 0; step < SOLVE_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (holds(middle)) high = middle;
    else low = middle;
  }
  return high;
}

function largestThat(holds: (amount: number) => boolean, most: number): number {
  let low = 0;
  let high = most;
  for (let step = 0; step < SOLVE_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (holds(middle)) low = middle;
    else high = middle;
  }
  return low;
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

function handOut(
  windows: readonly SlotWindow[],
  targets: readonly RebalanceShard[],
  fills: readonly number[],
  sourceCpu: number,
): RebalanceMove[] {
  const takers = targets
    .map((target, index) => ({ target, fill: fills[index], slots: [] as SlotLoadRate[] }))
    .filter((taker) => taker.fill > SLACK);
  if (takers.length === 0) return [];
  const ordered = windows.flatMap((window) => window.slots).sort((a, b) => a.slot - b.slot);
  let at = 0;
  let poured = 0;
  for (const slot of ordered) {
    if (at < takers.length - 1 && poured >= takers[at].fill - SLACK) {
      at += 1;
      poured = 0;
    }
    takers[at].slots.push(slot);
    poured += slot.cpuUsecPerSecond;
  }
  return takers
    .filter((taker) => taker.slots.length > 0)
    .map(({ target, slots }) => {
      const cpu = cpuOf(slots);
      return {
        targetShardId: target.shardId,
        targetAddr: target.nodeAddr,
        ranges: rangesOf(slots),
        slotCount: slots.length,
        keyCount: keysOf(slots),
        cpuUsecPerSecond: cpu,
        shareOfShard: cpu / sourceCpu,
      };
    });
}

export function planRebalance(
  input: RebalanceInput,
  policy: RebalancePolicy = DEFAULT_REBALANCE_POLICY,
): RebalanceVerdict {
  if (input.shards.some((shard) => shard.state !== 'healthy')) {
    return noRebalancePlan('unhealthy_node');
  }
  const source = input.shards.find((shard) => shard.shardId === input.hotShardId);
  const sourceCpu = cpuOf(input.slots);
  if (!source || sourceCpu <= 0) return noRebalancePlan('settling');

  const cpuBefore = (shard: RebalanceShard) =>
    shard === source ? sourceCpu : shard.cpuUsecPerSecond;
  const owners = input.shards.filter((shard) => shard === source || shard.slotCount > 0);
  const medianBefore = median(owners.map(cpuBefore));
  if (hotShardRatio(sourceCpu, medianBefore) <= policy.resolveRatio) {
    return noRebalancePlan('settling');
  }

  const pinned = input.slots
    .filter((slot) => slot.cpuUsecPerSecond >= policy.pinnedSlotShare * sourceCpu)
    .sort((a, b) => b.cpuUsecPerSecond - a.cpuUsecPerSecond || a.slot - b.slot);
  const pinnedSlots = pinned.map((slot) => ({
    slot: slot.slot,
    shareOfShard: slot.cpuUsecPerSecond / sourceCpu,
  }));
  if (cpuOf(pinned) >= policy.nodeCpuLimitUsecPerSecond) {
    return noRebalancePlan('key_level', pinnedSlots);
  }

  const kept = new Set([...pinned.map((slot) => slot.slot), ...policy.excludedSlots]);
  const movable = input.slots
    .filter((slot) => !kept.has(slot.slot))
    .sort((a, b) => a.slot - b.slot);
  const movableCpu = cpuOf(movable);

  const sameZone = (shard: RebalanceShard) =>
    source.availabilityZone !== undefined && shard.availabilityZone === source.availabilityZone
      ? 0
      : 1;
  const candidates = input.shards
    .filter(
      (shard) => shard !== source && !shard.hot && !policy.excludedShardIds.includes(shard.shardId),
    )
    .sort(
      (a, b) =>
        a.cpuUsecPerSecond - b.cpuUsecPerSecond ||
        sameZone(a) - sameZone(b) ||
        (a.shardId < b.shardId ? -1 : 1),
    );
  if (candidates.length === 0) return noRebalancePlan('no_target', pinnedSlots);

  const outlook = (targets: readonly RebalanceShard[], amount: number): Outlook => {
    const fills = waterFill(
      targets.map((target) => target.cpuUsecPerSecond),
      amount,
    );
    const after = targets.map((target, index) => target.cpuUsecPerSecond + fills[index]);
    const loads = [
      ...owners
        .filter((shard) => shard !== source && !targets.includes(shard))
        .map((shard) => shard.cpuUsecPerSecond),
      sourceCpu - amount,
      ...after.filter((_, index) => targets[index].slotCount > 0 || fills[index] > 0),
    ];
    const medianAfter = median(loads);
    return {
      fills,
      sourceRatio: hotShardRatio(sourceCpu - amount, medianAfter),
      targetsFit: after.every(
        (cpu, index) =>
          fills[index] <= 0 ||
          (cpu <= policy.nodeCpuLimitUsecPerSecond &&
            hotShardRatio(cpu, medianAfter) <= policy.resolveRatio),
      ),
    };
  };

  const most = Math.min(Math.max(1, policy.maxTargets), candidates.length);
  let targets: RebalanceShard[] = [];
  let amount = 0;
  for (let count = 1; count <= most && targets.length === 0; count += 1) {
    const tried = candidates.slice(0, count);
    const resolves = (moved: number) => outlook(tried, moved).sourceRatio <= policy.resolveRatio;
    if (!resolves(movableCpu)) continue;
    const needed = smallestThat(resolves, movableCpu);
    if (!outlook(tried, needed).targetsFit) continue;
    targets = tried;
    amount = needed;
  }
  if (targets.length === 0) {
    targets = candidates.slice(0, most);
    const fits = (moved: number) => outlook(targets, moved).targetsFit;
    const allFits = fits(movableCpu);
    amount = allFits ? movableCpu : largestThat(fits, movableCpu);
    if (amount < policy.headroomShare * sourceCpu - SLACK) {
      return noRebalancePlan(allFits ? 'key_level' : 'cluster_hot', pinnedSlots);
    }
  }

  const windows = selectWindows(
    movable,
    amount,
    Math.max(1, policy.maxRanges - (targets.length - 1)),
  );
  const freed = windows.reduce((total, window) => total + window.cpu, 0);
  const moves = handOut(
    windows,
    targets,
    waterFill(
      targets.map((target) => target.cpuUsecPerSecond),
      freed,
    ),
    sourceCpu,
  );
  if (moves.length === 0) return noRebalancePlan('settling', pinnedSlots);

  const gained = new Map(moves.map((move) => [move.targetShardId, move.cpuUsecPerSecond]));
  const cpuAfter = (shard: RebalanceShard) =>
    shard === source
      ? sourceCpu - freed
      : shard.cpuUsecPerSecond + (gained.get(shard.shardId) ?? 0);
  const medianAfter = median(
    input.shards
      .filter((shard) => owners.includes(shard) || gained.has(shard.shardId))
      .map(cpuAfter),
  );
  const effect =
    hotShardRatio(sourceCpu - freed, medianAfter) <= policy.resolveRatio + SLACK
      ? 'resolves'
      : 'headroom';
  if (effect === 'headroom' && freed < policy.headroomShare * sourceCpu - SLACK) {
    return noRebalancePlan('slots_scattered', pinnedSlots);
  }

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
  for (const target of targets) {
    if (!gained.has(target.shardId)) continue;
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
  };
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
  policy: RebalancePolicy = DEFAULT_REBALANCE_POLICY,
): RebalanceWarning[] {
  const source = memoryByShard.get(plan.sourceShardId);
  return plan.moves.flatMap((move): RebalanceWarning[] => {
    const target = memoryByShard.get(move.targetShardId);
    if (!source || source.keyCount <= 0 || !target || target.maxBytes <= 0) {
      return [{ code: 'memory_unknown', shardId: move.targetShardId }];
    }
    const bytesPerKey = source.usedBytes / source.keyCount;
    const memoryShare = (target.usedBytes + move.keyCount * bytesPerKey) / target.maxBytes;
    return memoryShare > policy.targetMemoryShare
      ? [{ code: 'target_memory', shardId: move.targetShardId, memoryShare }]
      : [];
  });
}

function listed(values: readonly number[]): string {
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

const NO_PLAN_SENTENCES: Record<Exclude<RebalanceNoPlanReason, 'key_level'>, string> = {
  cluster_hot:
    ' Rebalancing will not help: no other shard has room for this load. Consider adding a shard.',
  no_target: ' No rebalance is suggested: no other primary can take slots.',
  unhealthy_node: ' No rebalance is suggested while a primary is failed or suspect.',
  migration_running: ' No rebalance is suggested while a slot migration is running.',
  settling: ' No rebalance is suggested until the slot load settles.',
  slots_scattered:
    " No rebalance is suggested: this shard's slots are too scattered to move enough load in a few ranges.",
};

export function describeNoPlan(
  verdict: RebalanceVerdict | undefined,
  topKeys: readonly HotShardKey[],
): string {
  if (!verdict || verdict.kind === 'plan') return '';
  if (verdict.reason === 'key_level') return describeKeyLevel(verdict.pinnedSlots, topKeys);
  return NO_PLAN_SENTENCES[verdict.reason];
}
