import { DEFAULT_PLACEMENT_SETTINGS } from '@betterdb/shared';
import { evenShards } from './model';
import {
  type NodeSlotStats,
  PlacementTriggers,
  ShardLoadTracker,
  resolveStalenessMs,
} from './product';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SHARDS = 6;
const BASE_CPU_USEC_PER_SLOT = 60;
const BYTES_PER_SLOT = 400;
const LEAD_MS = 40 * MINUTE_MS;
const TAIL_MS = 40 * MINUTE_MS;

export interface PeakCase {
  peakMinutes: number;
  peakFactor: number;
  pollSeconds: number;
  days: number;
  gap?: { fromMinute: number; toMinute: number };
  bursts?: { onMinutes: number; everyMinutes: number };
}

export interface PeakRun {
  hotShardId: string;
  firesByDay: number[];
  otherShardFires: number;
  samples: number;
  peakOverShare: number;
}

export function runPeaks({
  peakMinutes,
  peakFactor,
  pollSeconds,
  days,
  gap,
  bursts,
}: PeakCase): PeakRun {
  const shards = evenShards(SHARDS);
  const hot = shards[0];
  const counters = shards.map((shard) => {
    const stats: NodeSlotStats['stats'] = {};
    for (let slot = shard.slots[0]; slot <= shard.slots[1]; slot++) {
      stats[slot] = { key_count: 30, cpu_usec: 0, network_bytes_in: 0, network_bytes_out: 0 };
    }
    return { nodeId: shard.nodeId, address: shard.address, stats };
  });
  const tracker = new ShardLoadTracker();
  const triggers = new PlacementTriggers();
  const staleMs = resolveStalenessMs(pollSeconds * 1000);
  triggers.configure('bench', DEFAULT_PLACEMENT_SETTINGS);
  const firesByDay = Array.from({ length: days }, () => 0);
  const last = new Map<string, string>();
  let otherShardFires = 0;
  let samples = 0;
  let peakOverShare = 0;
  let clock = 0;

  const hotFactor = (sinceStartMs: number) => {
    if (sinceStartMs <= 0 || sinceStartMs > peakMinutes * MINUTE_MS) return 1;
    if (!bursts) return peakFactor;
    const minute = (sinceStartMs - 1) / MINUTE_MS;
    return minute % bursts.everyMinutes < bursts.onMinutes ? peakFactor : 1;
  };
  const skipped = (sinceStartMs: number) =>
    gap !== undefined &&
    sinceStartMs > gap.fromMinute * MINUTE_MS &&
    sinceStartMs < gap.toMinute * MINUTE_MS;

  const advance = (to: number, hotLoad: number) => {
    const seconds = (to - clock) / 1000;
    for (const node of counters) {
      const factor = node.nodeId === hot.nodeId ? hotLoad : 1;
      for (const stats of Object.values(node.stats)) {
        stats.cpu_usec = (stats.cpu_usec ?? 0) + BASE_CPU_USEC_PER_SLOT * factor * seconds;
        stats.network_bytes_in = (stats.network_bytes_in ?? 0) + BYTES_PER_SLOT * seconds;
        stats.network_bytes_out = (stats.network_bytes_out ?? 0) + BYTES_PER_SLOT * seconds;
      }
    }
    clock = to;
  };

  for (let day = 0; day < days; day++) {
    const peakStart = day * DAY_MS + 12 * 60 * MINUTE_MS;
    const peakEnd = peakStart + peakMinutes * MINUTE_MS;
    for (let at = peakStart - LEAD_MS; at <= peakEnd + TAIL_MS; at += pollSeconds * 1000) {
      advance(at, hotFactor(at - peakStart));
      if (skipped(at - peakStart)) continue;
      const sample = tracker.observe(counters, at);
      if (!sample) continue;
      samples += 1;
      triggers.observe('bench', sample, staleMs);
      for (const shard of sample.shards) {
        const read = triggers.read('bench', shard.nodeId, at, staleMs);
        if (read.state === 'over' && last.get(shard.nodeId) !== 'over') {
          if (shard.nodeId === hot.nodeId) firesByDay[day] += 1;
          else otherShardFires += 1;
        }
        if (shard.nodeId === hot.nodeId) peakOverShare = Math.max(peakOverShare, read.overShare);
        last.set(shard.nodeId, read.state);
      }
    }
  }
  return { hotShardId: hot.nodeId, firesByDay, otherShardFires, samples, peakOverShare };
}
