import type { ReplicationLagEntry, SyncStage } from '@betterdb/shared';
import type { ParsedLogLine } from './log-parser';

export type ReplicationLagMap = Map<string, { diff: number | null; updatedAt: number }>;

export const LAG_FRESHNESS_FLOOR_MS = 10_000;
const LOG_INTERVAL_MS = 1_000;

export function applyLagUpdate(
  map: ReplicationLagMap,
  parsed: Pick<ParsedLogLine, 'shardLag' | 'shardState'>,
  now: number,
): void {
  if (parsed.shardLag) {
    map.set(parsed.shardLag.shard, { diff: parsed.shardLag.diff, updatedAt: now });
    return;
  }
  if (parsed.shardState && !parsed.shardState.inAof) {
    map.set(parsed.shardState.shard, { diff: null, updatedAt: now });
  }
}

function lagFreshnessWindowMs(expectedShards: number): number {
  return Math.max(LAG_FRESHNESS_FLOOR_MS, 3 * expectedShards * LOG_INTERVAL_MS);
}

function shardIndex(shard: string): number {
  return parseInt(shard.slice('src-'.length), 10);
}

export function buildLagSnapshot(
  map: ReplicationLagMap | null,
  expectedShards: number | null,
  syncStage: SyncStage | null,
  now: number,
): { replicationLag: ReplicationLagEntry[] | null; fullySynced: boolean } {
  if (map === null) {
    return { replicationLag: null, fullySynced: false };
  }
  const replicationLag = [...map.entries()]
    .map(([shard, { diff, updatedAt }]) => ({ shard, diff, updatedAt }))
    .sort((a, b) => shardIndex(a.shard) - shardIndex(b.shard));

  if (syncStage !== 'aof_replicating' || expectedShards === null || replicationLag.length < expectedShards) {
    return { replicationLag, fullySynced: false };
  }
  const window = lagFreshnessWindowMs(expectedShards);
  const fullySynced = replicationLag.every((e) => e.diff === 0 && now - e.updatedAt <= window);
  return { replicationLag, fullySynced };
}

export async function countSourceShards(
  adapter: { getClusterNodes(): Promise<Array<{ flags: string[]; slots: number[][] }>> },
  isCluster: boolean,
): Promise<number | null> {
  if (!isCluster) {
    return 1;
  }
  try {
    const nodes = await adapter.getClusterNodes();
    const masters = nodes.filter((n) => n.flags.includes('master') && n.slots.length > 0).length;
    return masters > 0 ? masters : null;
  } catch {
    return null;
  }
}
