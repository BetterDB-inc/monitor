import { SHARD_LOAD_SUSTAIN_MINUTES, type ShardLoadSample } from './shard-load';

export interface SustainEntry {
  timestamp: number;
  settling: boolean;
  sustainCpuUsecPerSecond: number;
  medianSustainCpuUsecPerSecond: number;
  sustainShare: number;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export class SustainHistory {
  private readonly shards = new Map<string, SustainEntry[]>();
  private retentionMs = SHARD_LOAD_SUSTAIN_MINUTES * 60_000;

  setSustainMinutes(minutes: number): void {
    if (Number.isFinite(minutes) && minutes > 0) this.retentionMs = minutes * 60_000;
  }

  record(sample: ShardLoadSample): void {
    const owning = sample.shards.filter((shard) => shard.slotCount > 0);
    const median = medianOf(owning.map((shard) => shard.sustainCpuUsecPerSecond));
    const total = owning.reduce((sum, shard) => sum + shard.sustainCpuUsecPerSecond, 0);
    const present = new Set<string>();
    for (const shard of owning) {
      present.add(shard.nodeId);
      const entries = this.shards.get(shard.nodeId) ?? [];
      const last = entries[entries.length - 1];
      if (last && sample.timestamp <= last.timestamp) continue;
      entries.push({
        timestamp: sample.timestamp,
        settling: sample.settling,
        sustainCpuUsecPerSecond: shard.sustainCpuUsecPerSecond,
        medianSustainCpuUsecPerSecond: median,
        sustainShare: total > 0 ? shard.sustainCpuUsecPerSecond / total : 0,
      });
      this.shards.set(shard.nodeId, entries);
    }
    for (const shardId of [...this.shards.keys()]) {
      if (!present.has(shardId)) this.shards.delete(shardId);
    }
    this.prune(sample.timestamp);
  }

  entries(shardId: string): readonly SustainEntry[] {
    return this.shards.get(shardId) ?? [];
  }

  clear(): void {
    this.shards.clear();
  }

  private prune(now: number): void {
    const oldest = now - this.retentionMs;
    for (const entries of this.shards.values()) {
      const keep = entries.findIndex((entry) => entry.timestamp >= oldest);
      if (keep > 0) entries.splice(0, keep);
      else if (keep < 0) entries.length = 0;
    }
  }
}
