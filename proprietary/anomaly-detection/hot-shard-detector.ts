import type { ShardLoad, ShardLoadSample, SlotLoadRate } from '@app/cluster/shard-load';
import { median } from '../latency-regression/regression-detector';
import { type HotShardKey, type HotShardKeyDetail, describeHotKeys } from './hot-shard-keys';

export const HOT_SHARD_MIN_PRIMARIES = 3;
export const HOT_SHARD_RAISE_FACTOR = 2;
export const HOT_SHARD_RELEASE_FACTOR = 1.5;
export const HOT_SHARD_HOLD_MS = 60_000;
export const HOT_SHARD_BLIND_MS = 5 * 60_000;
export const HOT_SHARD_TOP_SLOTS = 5;
export const HOT_SHARD_CPU_FLOOR_USEC_PER_SECOND = 100_000;
export const HOT_SHARD_NETWORK_FLOOR_BYTES_PER_SECOND = 1024 * 1024;

const MESSAGE_TOP_SLOTS = 3;
const MIB = 1024 * 1024;

export type HotShardMetric = 'cpu' | 'network';

export interface HotShardLoad {
  perSecond: number;
  share: number;
  median: number;
  ratio: number;
}

export interface HotShardFinding {
  shardId: string;
  nodeAddr: string;
  slotCount: number;
  cpu: HotShardLoad;
  network: HotShardLoad;
  over: HotShardMetric[];
}

export interface HotShardSlot {
  slot: number;
  cpuUsecPerSecond: number;
  networkBytesPerSecond: number;
  keyCount: number;
  shareOfShard: number;
}

export interface HotShardDetail extends HotShardKeyDetail {
  eventId: string;
  captureAvailable: boolean;
  shardId: string;
  nodeAddr: string;
  slotCount: number;
  since: number;
  sampledAt: number;
  cpu: HotShardLoad;
  network: HotShardLoad;
  rankedBy: HotShardMetric;
  topSlots: HotShardSlot[];
}

interface MetricRule {
  metric: HotShardMetric;
  floor: number;
  rate: (shard: ShardLoad) => number;
  share: (shard: ShardLoad) => number;
}

const RULES: MetricRule[] = [
  {
    metric: 'cpu',
    floor: HOT_SHARD_CPU_FLOOR_USEC_PER_SECOND,
    rate: (shard) => shard.cpuUsecPerSecond,
    share: (shard) => shard.cpuShare,
  },
  {
    metric: 'network',
    floor: HOT_SHARD_NETWORK_FLOOR_BYTES_PER_SECOND,
    rate: (shard) => shard.networkBytesInPerSecond + shard.networkBytesOutPerSecond,
    share: (shard) => shard.networkShare,
  },
];

function referenceOf(rule: MetricRule, middle: number): number {
  return Math.max(middle, rule.floor / HOT_SHARD_RAISE_FACTOR);
}

function isNearIdle(metric: HotShardMetric, load: HotShardLoad): boolean {
  const rule = RULES.find((r) => r.metric === metric)!;
  return load.median < rule.floor / HOT_SHARD_RAISE_FACTOR;
}

export function hotShardSignature(shardId: string): string {
  return `hot_shard:${shardId}`;
}

export function judgeHotShards(
  sample: ShardLoadSample,
  openShardIds: ReadonlySet<string>,
): HotShardFinding[] | null {
  if (sample.settling) return null;
  const shards = sample.shards.filter((shard) => shard.slotCount > 0);
  if (shards.length < HOT_SHARD_MIN_PRIMARIES) return [];

  const medians = new Map(RULES.map((rule) => [rule.metric, median(shards.map(rule.rate))]));
  const findings: HotShardFinding[] = [];
  for (const shard of shards) {
    const factor = openShardIds.has(shard.nodeId)
      ? HOT_SHARD_RELEASE_FACTOR
      : HOT_SHARD_RAISE_FACTOR;
    const loads = new Map<HotShardMetric, HotShardLoad>();
    for (const rule of RULES) {
      const middle = medians.get(rule.metric)!;
      const perSecond = rule.rate(shard);
      loads.set(rule.metric, {
        perSecond,
        share: rule.share(shard),
        median: middle,
        ratio: perSecond / referenceOf(rule, middle),
      });
    }
    const over = RULES.map((rule) => rule.metric)
      .filter((metric) => loads.get(metric)!.ratio >= factor)
      .sort((a, b) => loads.get(b)!.ratio - loads.get(a)!.ratio);
    if (over.length === 0) continue;
    findings.push({
      shardId: shard.nodeId,
      nodeAddr: shard.address,
      slotCount: shard.slotCount,
      cpu: loads.get('cpu')!,
      network: loads.get('network')!,
      over,
    });
  }
  return findings;
}

export function hotShardSlots(
  finding: HotShardFinding,
  slots: readonly SlotLoadRate[],
): HotShardSlot[] {
  const metric = finding.over[0];
  const total = finding[metric].perSecond;
  return slots.map((slot) => {
    const network = slot.networkBytesInPerSecond + slot.networkBytesOutPerSecond;
    const rate = metric === 'cpu' ? slot.cpuUsecPerSecond : network;
    return {
      slot: slot.slot,
      cpuUsecPerSecond: slot.cpuUsecPerSecond,
      networkBytesPerSecond: network,
      keyCount: slot.keyCount,
      shareOfShard: total > 0 ? rate / total : 0,
    };
  });
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function describeLoad(metric: HotShardMetric, load: HotShardLoad): string {
  const label = metric === 'cpu' ? 'CPU' : 'network';
  const total = metric === 'cpu' ? "the cluster's slot CPU" : "the cluster's network bytes";
  const size = isNearIdle(metric, load)
    ? `${
        metric === 'cpu'
          ? `${(load.perSecond / 1_000_000).toFixed(2)} cores`
          : `${(load.perSecond / MIB).toFixed(1)} MiB/s`
      } against a near-idle cluster median`
    : `${load.ratio.toFixed(1)}x the cluster median`;
  return `${label} ${size} (${percent(load.share)} of ${total})`;
}

export function describeHotShard(
  finding: HotShardFinding,
  topSlots: readonly HotShardSlot[],
  heldMs: number,
  topKeys: readonly HotShardKey[] = [],
  keysNote = '',
): string {
  const loads = finding.over.map((metric) => describeLoad(metric, finding[metric])).join(', ');
  const listed = topSlots.slice(0, MESSAGE_TOP_SLOTS);
  const slots = listed
    .map(
      (slot, i) => `${slot.slot} (${percent(slot.shareOfShard)}${i === 0 ? ' of the shard' : ''})`,
    )
    .join(', ');
  const rankedBy = finding.over[0] === 'cpu' ? 'CPU' : 'network';
  return (
    `Hot shard ${finding.shardId.substring(0, 8)} at ${finding.nodeAddr}: ${loads} ` +
    `for ${Math.round(heldMs / 1000)}s.` +
    (listed.length > 0 ? ` Top slots by ${rankedBy}: ${slots}.` : '') +
    describeHotKeys(topKeys) +
    keysNote
  );
}
