import type { ReplicationLagEntry } from '@betterdb/shared';
import type { ShakeStatus } from './shake-status';

export const STATUS_POLL_MS = 1_000;
export const STATUS_POLL_TIMEOUT_MS = 900;
export const LAG_STALE_MS = 5_000;
const MIN_CONSISTENT_POLLS = 2;

export interface LagState {
  status: ShakeStatus | null;
  updatedAt: number;
  consistentPolls: number;
}

export function createLagState(): LagState {
  return { status: null, updatedAt: 0, consistentPolls: 0 };
}

export function applyStatusPoll(state: LagState, status: ShakeStatus | null, now: number): void {
  if (status === null) {
    state.consistentPolls = 0;
    return;
  }
  state.status = status;
  state.updatedAt = now;
  state.consistentPolls = status.consistent ? state.consistentPolls + 1 : 0;
}

export function buildLagSnapshot(
  state: LagState | null,
  now: number,
): { replicationLag: ReplicationLagEntry[] | null; shards: number | null; fullySynced: boolean } {
  if (state === null) {
    return { replicationLag: null, shards: null, fullySynced: false };
  }
  if (state.status === null) {
    return { replicationLag: [], shards: null, fullySynced: false };
  }
  const stale = now - state.updatedAt > LAG_STALE_MS;
  const { shards } = state.status;
  const replicationLag = shards.map(({ shard, diff }) => ({ shard, diff, stale }));
  const fullySynced =
    !stale &&
    state.consistentPolls >= MIN_CONSISTENT_POLLS &&
    shards.every((s) => s.inAof);
  return { replicationLag, shards: shards.length, fullySynced };
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
