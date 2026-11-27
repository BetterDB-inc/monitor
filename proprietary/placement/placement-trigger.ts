import type { PlacementSettings, PlacementTriggerRead } from '@betterdb/shared';
import type { ShardLoad, ShardLoadSample } from '@app/cluster/shard-load';
import {
  HOT_SHARD_MIN_PRIMARIES,
  hotShardRatio,
  hotShardShare,
} from '../anomaly-detection/hot-shard-detector';
import { median } from '../latency-regression/regression-detector';

export const TRIGGER_MIN_HISTORY_SHARE = 0.8;
export const TRIGGER_OVER_SHARE = 0.9;
export const TRIGGER_BUCKET_MS = 60_000;

export type TriggerSettings = Pick<
  PlacementSettings,
  'sustainMinutes' | 'triggerRatio' | 'maxCpuShare'
>;

interface Bucket {
  start: number;
  coveredMs: number;
  overMs: number;
}

interface ShardTrack {
  buckets: Bucket[];
  lastAt: number;
  firedAt: number | null;
  read: PlacementTriggerRead;
}

interface SeedTrack {
  settings: TriggerSettings;
  shards: Map<string, ShardTrack>;
}

const NO_HISTORY: PlacementTriggerRead = {
  state: 'short_history',
  overShare: 0,
  coveredMs: 0,
  firedAt: null,
  warmUntil: null,
};

function sameSettings(a: TriggerSettings, b: TriggerSettings): boolean {
  return (
    a.sustainMinutes === b.sustainMinutes &&
    a.triggerRatio === b.triggerRatio &&
    a.maxCpuShare === b.maxCpuShare
  );
}

function isOver(
  shard: ShardLoad,
  owning: readonly ShardLoad[],
  sustainMedian: number,
  sustainTotal: number,
  settings: TriggerSettings,
): boolean {
  if (owning.length < HOT_SHARD_MIN_PRIMARIES) return false;
  if (hotShardRatio(shard.sustainCpuUsecPerSecond, sustainMedian) >= settings.triggerRatio)
    return true;
  if (settings.maxCpuShare === null) return false;
  return (
    hotShardShare(shard.sustainCpuUsecPerSecond, sustainTotal, owning.length) >=
    settings.maxCpuShare
  );
}

function addSpan(buckets: Bucket[], from: number, to: number, over: boolean): void {
  let at = from;
  while (at < to) {
    const start = Math.floor(at / TRIGGER_BUCKET_MS) * TRIGGER_BUCKET_MS;
    const end = Math.min(to, start + TRIGGER_BUCKET_MS);
    let bucket = buckets[buckets.length - 1];
    if (!bucket || bucket.start !== start) {
      bucket = { start, coveredMs: 0, overMs: 0 };
      buckets.push(bucket);
    }
    bucket.coveredMs += end - at;
    if (over) bucket.overMs += end - at;
    at = end;
  }
}

function prune(buckets: Bucket[], windowStart: number): void {
  let drop = 0;
  while (drop < buckets.length && buckets[drop].start + TRIGGER_BUCKET_MS <= windowStart) drop++;
  if (drop > 0) buckets.splice(0, drop);
}

function evaluate(buckets: readonly Bucket[], settings: TriggerSettings, now: number) {
  const sustainMs = settings.sustainMinutes * 60_000;
  const windowStart = now - sustainMs;
  let coveredMs = 0;
  let overMs = 0;
  for (const bucket of buckets) {
    const end = bucket.start + TRIGGER_BUCKET_MS;
    if (end <= windowStart || bucket.start > now) continue;
    const share = bucket.start >= windowStart ? 1 : (end - windowStart) / TRIGGER_BUCKET_MS;
    coveredMs += bucket.coveredMs * share;
    overMs += bucket.overMs * share;
  }
  const overShare = coveredMs > 0 ? overMs / coveredMs : 0;
  const neededMs = TRIGGER_MIN_HISTORY_SHARE * sustainMs;
  if (coveredMs < neededMs) {
    return {
      state: 'short_history' as const,
      overShare,
      coveredMs,
      warmUntil: now + (neededMs - coveredMs),
    };
  }
  return {
    state: overShare >= TRIGGER_OVER_SHARE ? ('over' as const) : ('under' as const),
    overShare,
    coveredMs,
    warmUntil: null,
  };
}

export class PlacementTriggers {
  private readonly tracks = new Map<string, SeedTrack>();

  configure(seedId: string, settings: TriggerSettings): void {
    const track = this.tracks.get(seedId);
    if (track && sameSettings(track.settings, settings)) return;
    this.tracks.set(seedId, { settings: { ...settings }, shards: new Map() });
  }

  observe(seedId: string, sample: ShardLoadSample, staleMs: number): void {
    const track = this.tracks.get(seedId);
    if (!track) return;
    const { settings, shards } = track;
    const owning = sample.shards.filter((shard) => shard.slotCount > 0);
    const sustainMedian =
      owning.length > 0 ? median(owning.map((shard) => shard.sustainCpuUsecPerSecond)) : 0;
    const sustainTotal = owning.reduce((sum, shard) => sum + shard.sustainCpuUsecPerSecond, 0);
    const sustainMs = settings.sustainMinutes * 60_000;
    const windowStart = sample.timestamp - sustainMs;
    const present = new Set<string>();
    for (const shard of owning) {
      present.add(shard.nodeId);
      let shardTrack = shards.get(shard.nodeId);
      if (shard.sustainReset) shardTrack = undefined;
      if (shardTrack && sample.timestamp <= shardTrack.lastAt) continue;
      if (!shardTrack) {
        shardTrack = { buckets: [], lastAt: sample.timestamp, firedAt: null, read: NO_HISTORY };
        shards.set(shard.nodeId, shardTrack);
      }
      const weight = Math.min(sample.timestamp - shardTrack.lastAt, staleMs);
      if (!sample.settling && weight > 0) {
        const over = isOver(shard, owning, sustainMedian, sustainTotal, settings);
        addSpan(shardTrack.buckets, sample.timestamp - weight, sample.timestamp, over);
      }
      shardTrack.lastAt = sample.timestamp;
      prune(shardTrack.buckets, windowStart);
      const read = evaluate(shardTrack.buckets, settings, sample.timestamp);
      shardTrack.firedAt = read.state === 'over' ? (shardTrack.firedAt ?? sample.timestamp) : null;
      shardTrack.read = { ...read, firedAt: shardTrack.firedAt };
    }
    for (const [shardId, shardTrack] of [...shards]) {
      if (!present.has(shardId) && sample.timestamp - shardTrack.lastAt > sustainMs) {
        shards.delete(shardId);
      }
    }
  }

  read(seedId: string, shardId: string, now: number, staleMs: number): PlacementTriggerRead {
    const shardTrack = this.tracks.get(seedId)?.shards.get(shardId);
    if (!shardTrack) return NO_HISTORY;
    if (now - shardTrack.lastAt > staleMs) {
      return { ...shardTrack.read, state: 'short_history', firedAt: null, warmUntil: null };
    }
    return shardTrack.read;
  }

  reset(seedId: string): void {
    this.tracks.get(seedId)?.shards.clear();
  }

  seeds(): string[] {
    return [...this.tracks.keys()];
  }

  forget(seedId: string): void {
    this.tracks.delete(seedId);
  }
}
