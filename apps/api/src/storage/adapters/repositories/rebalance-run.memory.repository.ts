import type {
  RebalanceRunQueryOptions,
  StoredRebalanceRun,
} from '../../../common/interfaces/storage-port.interface';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

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

  async pruneOldRebalanceRuns(cutoffTimestamp: number, connectionId?: string): Promise<number> {
    let pruned = 0;
    for (const [id, run] of this.runs) {
      if (run.endedAt === null || run.endedAt >= cutoffTimestamp) continue;
      if (connectionId && run.connectionId !== connectionId) continue;
      this.runs.delete(id);
      pruned += 1;
    }
    return pruned;
  }
}
