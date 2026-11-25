import type { PlacementBalance, PlacementShardBalance } from '@betterdb/shared';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import {
  HOT_SHARD_MIN_PRIMARIES,
  HOT_SHARD_RAISE_FACTOR,
  hotShardRatio,
} from '../anomaly-detection/hot-shard-detector';
import { median } from '../latency-regression/regression-detector';

export const PLACEMENT_TRIGGER_RATIO = HOT_SHARD_RAISE_FACTOR;
export const PLACEMENT_RESOLVE_RATIO = 1.25;

export function placementBalance(sample: ShardLoadSample | null): PlacementBalance | null {
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
      overTrigger: judged && ratio !== null && ratio >= PLACEMENT_TRIGGER_RATIO,
    };
  });
  shards.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1));
  return {
    sampledAt: sample.timestamp,
    settling: sample.settling,
    medianCpuUsecPerSecond: cpuMedian,
    triggerRatio: PLACEMENT_TRIGGER_RATIO,
    resolveRatio: PLACEMENT_RESOLVE_RATIO,
    shards,
  };
}
