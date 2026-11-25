import { rebalanceShards } from './glue';
import { type LoadModel, slotStatsAt } from './model';
import {
  type RebalanceVerdict,
  ShardLoadTracker,
  type ShardLoadSample,
  judgeHotShards,
  placementBalance,
  planRebalances,
} from './product';

export const POLL_SECONDS = 15;

export interface Simulation {
  sample: ShardLoadSample;
  hotShardIds: string[];
  verdicts: RebalanceVerdict[];
  balance: ReturnType<typeof placementBalance>;
  tracker: ShardLoadTracker;
}

export function simulate(model: LoadModel, minutes: number): Simulation {
  const tracker = new ShardLoadTracker();
  let sample: ShardLoadSample | null = null;
  for (let seconds = 0; seconds <= minutes * 60; seconds += POLL_SECONDS) {
    sample = tracker.observe(slotStatsAt(model, seconds), seconds * 1000) ?? sample;
  }
  if (!sample) throw new Error('the tracker produced no sample');
  const findings = judgeHotShards(sample, new Set()) ?? [];
  const hotShardIds = findings.map((finding) => finding.shardId);
  const verdicts = planRebalances(
    hotShardIds.map((hotShardId) => ({ hotShardId, slots: tracker.slotsOf(hotShardId) })),
    rebalanceShards(sample, new Set(hotShardIds)),
  );
  return { sample, hotShardIds, verdicts, balance: placementBalance(sample), tracker };
}
