export const RESHARD_MIN_PRIMARIES = 3;
export const RESHARD_MIN_CLUSTER_OPS = 1000;
export const RESHARD_QUIET_POLLS = 2;
export const RESHARD_PERSIST_POLLS = 3;
export const RESHARD_STALE_POLLS = 5;
export const RESHARD_MARKER_STALL_MS = 30 * 60_000;

export interface ReshardShardSnapshot {
  connectionId: string;
  clusterKey: string;
  shardId: string;
  migratingSlots: number;
  importingSlots: number;
  markerSignature: string;
  markerChangedAt: number;
  lastMarkerAt: number | null;
  opsPerSec: number;
  cpuUtilization: number | null;
  usedMemory: number;
  writeP99Us: number | null;
  timestamp: number;
}

export interface ReshardDeviation {
  metric: string;
  value: number;
  median: number;
  ratio: number;
  threshold: number;
}

export interface ReshardSkewFinding {
  clusterKey: string;
  shardId: string;
  role: string;
  deviations: ReshardDeviation[];
}

interface SkewRule {
  metric: string;
  read: (shard: ReshardShardSnapshot) => number | null;
  factor: number;
  floor: number;
}

const SKEW_RULES: SkewRule[] = [
  { metric: 'ops/sec', read: (s) => s.opsPerSec, factor: 2, floor: 500 },
  { metric: 'CPU', read: (s) => s.cpuUtilization, factor: 1.5, floor: 60 },
  { metric: 'memory', read: (s) => s.usedMemory, factor: 1.3, floor: 256 * 1024 * 1024 },
  { metric: 'write P99', read: (s) => s.writeP99Us, factor: 3, floor: 1000 },
];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function reshardMarkerSignature(
  migrating: readonly { slot: number }[],
  importing: readonly { slot: number }[],
): string {
  const slots = (entries: readonly { slot: number }[]) =>
    entries
      .map((entry) => entry.slot)
      .sort((a, b) => a - b)
      .join(',');
  return `${slots(migrating)}|${slots(importing)}`;
}

export function isMarkerStalled(markerChangedAt: number, now: number): boolean {
  return now - markerChangedAt >= RESHARD_MARKER_STALL_MS;
}

export function isReshardActive(
  shards: readonly ReshardShardSnapshot[],
  now: number,
  quietMs: number,
): boolean {
  return shards.some((s) => s.lastMarkerAt !== null && now - s.lastMarkerAt <= quietMs);
}

export function reshardRole(shard: ReshardShardSnapshot): string {
  if (shard.migratingSlots > 0 && shard.importingSlots > 0) return 'source and target';
  if (shard.migratingSlots > 0) return 'source';
  if (shard.importingSlots > 0) return 'target';
  return 'bystander';
}

export function evaluateReshardSkew(
  self: ReshardShardSnapshot,
  shards: readonly ReshardShardSnapshot[],
): ReshardSkewFinding | null {
  if (shards.length < RESHARD_MIN_PRIMARIES) return null;
  const clusterOps = shards.reduce((total, s) => total + s.opsPerSec, 0);
  if (clusterOps < RESHARD_MIN_CLUSTER_OPS) return null;

  const deviations: ReshardDeviation[] = [];
  for (const { metric, read, factor, floor } of SKEW_RULES) {
    const value = read(self);
    const reported = shards.map(read).filter((v): v is number => v !== null);
    if (value === null || reported.length < RESHARD_MIN_PRIMARIES) continue;
    const middle = median(reported);
    if (value < floor || value < factor * middle) continue;
    deviations.push({
      metric,
      value,
      median: middle,
      ratio: middle > 0 ? value / middle : factor,
      threshold: factor,
    });
  }
  if (deviations.length === 0) return null;

  return {
    clusterKey: self.clusterKey,
    shardId: self.shardId,
    role: reshardRole(self),
    deviations,
  };
}

export function reshardSkewSignature(finding: ReshardSkewFinding): string {
  return `reshard_skew:${finding.shardId}`;
}
