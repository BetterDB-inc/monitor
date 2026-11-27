import type {
  RebalanceRunQueryOptions,
  StoredRebalanceRun,
} from '../../../common/interfaces/storage-port.interface';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/**
 * How long before the retention cutoff a run that never ended must have started to be pruned.
 * At least the 30 days adoption looks back, so a run that may still be adopted is kept.
 */
export const REBALANCE_UNENDED_PRUNE_MARGIN_MS = 30 * 24 * 60 * 60_000;
export const unendedCutoff = (cutoffTimestamp: number): number =>
  cutoffTimestamp - REBALANCE_UNENDED_PRUNE_MARGIN_MS;

export const rebalanceRunLimit = (limit?: number): number =>
  Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT)), MAX_LIMIT);

export class RebalanceRunMemoryRepository {
  private readonly runs = new Map<string, StoredRebalanceRun>();

  async saveRebalanceRun(run: StoredRebalanceRun): Promise<void> {
    const stored = this.runs.get(run.id);
    if (stored && stored.updatedAt > run.updatedAt) return;
    this.runs.set(run.id, { ...run });
  }

  async getRebalanceRuns(options: RebalanceRunQueryOptions): Promise<StoredRebalanceRun[]> {
    return [...this.runs.values()]
      .filter((run) => run.connectionId === options.connectionId)
      .filter((run) => options.since === undefined || run.startedAt >= options.since)
      .filter((run) => !options.states || options.states.includes(run.state))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, rebalanceRunLimit(options.limit))
      .map((run) => ({ ...run }));
  }

  async getLatestRebalanceRunPerShard(
    connectionId: string,
    since: number,
  ): Promise<StoredRebalanceRun[]> {
    const latest = new Map<string, StoredRebalanceRun>();
    for (const run of this.runs.values()) {
      if (run.connectionId !== connectionId || run.startedAt < since) continue;
      const seen = latest.get(run.sourceShardId);
      if (!seen || run.startedAt > seen.startedAt) latest.set(run.sourceShardId, run);
    }
    return [...latest.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => ({ ...run }));
  }
  async pruneOldRebalanceRuns(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    let pruned = 0;
    for (const [id, run] of this.runs) {
      const expired =
        run.endedAt === null
          ? run.startedAt < unendedCutoff(cutoffTimestamp)
          : run.endedAt < cutoffTimestamp;
      if (!expired) continue;
      if (connectionId && run.connectionId !== connectionId) continue;
      this.runs.delete(id);
      pruned += 1;
    }
    return pruned;
  }
}
