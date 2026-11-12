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

const MESSAGE_TOP_SLOTS = 3;
const NEAR_IDLE_CPU_USEC_PER_SECOND = HOT_SHARD_CPU_FLOOR_USEC_PER_SECOND / HOT_SHARD_RAISE_FACTOR;

export interface HotShardLoad {
  perSecond: number;
  share: number;
  median: number;
  ratio: number;
}

export type HotShardNetwork = Omit<HotShardLoad, 'ratio'>;

export interface HotShardFinding {
  shardId: string;
  nodeAddr: string;
  slotCount: number;
  cpu: HotShardLoad;
  network: HotShardNetwork;
}

export interface HotShardSlot {
  slot: number;
  cpuUsecPerSecond: number;
  networkBytesPerSecond: number;
  keyCount: number;
  shareOfShard: number;
}

export interface HotShardDetail extends HotShardKeyDetail {
  shardId: string;
  nodeAddr: string;
  slotCount: number;
  since: number;
  sampledAt: number;
  cpu: HotShardLoad;
  network: HotShardNetwork;
  topSlots: HotShardSlot[];
}

function networkOf(shard: ShardLoad): number {
  return shard.networkBytesInPerSecond + shard.networkBytesOutPerSecond;
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

  const cpuMedian = median(shards.map((shard) => shard.cpuUsecPerSecond));
  const networkMedian = median(shards.map(networkOf));
  const findings: HotShardFinding[] = [];
  for (const shard of shards) {
    const factor = openShardIds.has(shard.nodeId)
      ? HOT_SHARD_RELEASE_FACTOR
      : HOT_SHARD_RAISE_FACTOR;
    const ratio = shard.cpuUsecPerSecond / Math.max(cpuMedian, NEAR_IDLE_CPU_USEC_PER_SECOND);
    if (ratio < factor) continue;
    findings.push({
      shardId: shard.nodeId,
      nodeAddr: shard.address,
      slotCount: shard.slotCount,
      cpu: {
        perSecond: shard.cpuUsecPerSecond,
        share: shard.cpuShare ?? 0,
        median: cpuMedian,
        ratio,
      },
      network: {
        perSecond: networkOf(shard),
        share: shard.networkShare ?? 0,
        median: networkMedian,
      },
    });
  }
  return findings;
}

export function hotShardSlots(
  finding: HotShardFinding,
  slots: readonly SlotLoadRate[],
): HotShardSlot[] {
  const total = finding.cpu.perSecond;
  return slots.map((slot) => ({
    slot: slot.slot,
    cpuUsecPerSecond: slot.cpuUsecPerSecond,
    networkBytesPerSecond: slot.networkBytesInPerSecond + slot.networkBytesOutPerSecond,
    keyCount: slot.keyCount,
    shareOfShard: total > 0 ? slot.cpuUsecPerSecond / total : 0,
  }));
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function describeCpu(load: HotShardLoad): string {
  const size =
    load.median < NEAR_IDLE_CPU_USEC_PER_SECOND
      ? `${(load.perSecond / 1_000_000).toFixed(2)} cores against a near-idle cluster median`
      : `${load.ratio.toFixed(1)}x the cluster median`;
  return `CPU ${size} (${percent(load.share)} of the cluster's slot CPU)`;
}

function describeNetwork(load: HotShardNetwork): string {
  if (load.perSecond <= 0) return '';
  return ` Network: ${percent(load.share)} of the cluster's bytes, replication included.`;
}

export function describeHotShard(
  finding: HotShardFinding,
  topSlots: readonly HotShardSlot[],
  heldMs: number,
  topKeys: readonly HotShardKey[] = [],
): string {
  const listed = topSlots.slice(0, MESSAGE_TOP_SLOTS);
  const slots = listed
    .map(
      (slot, i) => `${slot.slot} (${percent(slot.shareOfShard)}${i === 0 ? ' of the shard' : ''})`,
    )
    .join(', ');
  return (
    `Hot shard ${finding.shardId.substring(0, 8)} at ${finding.nodeAddr}: ` +
    `${describeCpu(finding.cpu)} for ${Math.round(heldMs / 1000)}s.` +
    describeNetwork(finding.network) +
    (listed.length > 0 ? ` Top slots by CPU: ${slots}.` : '') +
    describeHotKeys(topKeys)
  );
}
