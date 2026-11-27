import {
  DEFAULT_PLACEMENT_SETTINGS,
  type PlacementBalance,
  type PlacementSettings,
  type PlacementShardBalance,
  type PlacementTriggerRead,
} from '@betterdb/shared';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import { HOT_SHARD_MIN_PRIMARIES, hotShardRatio } from '../anomaly-detection/hot-shard-detector';
import { median } from '../latency-regression/regression-detector';

export function placementBalance(
  sample: ShardLoadSample | null,
  settings: PlacementSettings = DEFAULT_PLACEMENT_SETTINGS,
  triggerOf: (shardId: string) => PlacementTriggerRead | null = () => null,
): PlacementBalance | null {
  if (!sample) return null;
  const owning = sample.shards.filter((shard) => shard.slotCount > 0);
  const medianOf = (value: (shard: (typeof owning)[number]) => number) =>
    owning.length > 0 ? median(owning.map(value)) : 0;
  const cpuMedian = medianOf((shard) => shard.cpuUsecPerSecond);
  const sustainMedian = medianOf((shard) => shard.sustainCpuUsecPerSecond);
  const baselineMedian = medianOf((shard) => shard.baselineCpuUsecPerSecond);
  const judged = !sample.settling && owning.length >= HOT_SHARD_MIN_PRIMARIES;
  const shards: PlacementShardBalance[] = sample.shards.map((shard) => {
    const owns = shard.slotCount > 0;
    const ratio = owns ? hotShardRatio(shard.cpuUsecPerSecond, cpuMedian) : null;
    const trigger = owns ? triggerOf(shard.nodeId) : null;
    return {
      shardId: shard.nodeId,
      address: shard.address,
      slotCount: shard.slotCount,
      cpuUsecPerSecond: shard.cpuUsecPerSecond,
      cpuShare: shard.cpuShare,
      networkShare: shard.networkShare,
      ratio,
      overTrigger: judged && ratio !== null && ratio >= settings.triggerRatio,
      sustainCpuUsecPerSecond: shard.sustainCpuUsecPerSecond,
      sustainRatio: owns ? hotShardRatio(shard.sustainCpuUsecPerSecond, sustainMedian) : null,
      baselineRatio: owns ? hotShardRatio(shard.baselineCpuUsecPerSecond, baselineMedian) : null,
      trigger: trigger?.state ?? 'short_history',
      warmUntil: trigger?.warmUntil ?? null,
    };
  });
  shards.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
  return {
    sampledAt: sample.timestamp,
    settling: sample.settling,
    medianCpuUsecPerSecond: cpuMedian,
    triggerRatio: settings.triggerRatio,
    resolveRatio: settings.resolveRatio,
    shards,
  };
}
