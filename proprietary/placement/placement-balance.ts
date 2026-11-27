import {
  DEFAULT_PLACEMENT_SETTINGS,
  type PlacementBalance,
  type PlacementSettings,
  type PlacementShardBalance,
} from '@betterdb/shared';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import { HOT_SHARD_MIN_PRIMARIES, hotShardRatio } from '../anomaly-detection/hot-shard-detector';
import { median } from '../latency-regression/regression-detector';

export function placementBalance(
  sample: ShardLoadSample | null,
  settings: PlacementSettings = DEFAULT_PLACEMENT_SETTINGS,
): PlacementBalance | null {
  if (!sample) return null;
  const owning = sample.shards.filter((shard) => shard.slotCount > 0);
  const cpuMedian = owning.length > 0 ? median(owning.map((shard) => shard.cpuUsecPerSecond)) : 0;
  const judged = !sample.settling && owning.length >= HOT_SHARD_MIN_PRIMARIES;
  const shards: PlacementShardBalance[] = sample.shards.map((shard) => {
    const ratio = shard.slotCount > 0 ? hotShardRatio(shard.cpuUsecPerSecond, cpuMedian) : null;
    return {
      shardId: shard.nodeId,
      address: shard.address,
      slotCount: shard.slotCount,
      cpuUsecPerSecond: shard.cpuUsecPerSecond,
      cpuShare: shard.cpuShare,
      networkShare: shard.networkShare,
      ratio,
      overTrigger: judged && ratio !== null && ratio >= settings.triggerRatio,
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
