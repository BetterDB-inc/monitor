import type { StoredRebalanceRun } from '@app/common/interfaces/storage-port.interface';
import type { RebalanceRun } from './slot-rebalance-run';

const DAY_MS = 24 * 60 * 60_000;

/** How far back adoption looks for a run to pick up after a restart. */
export const REBALANCE_HISTORY_MAX_MS = 30 * DAY_MS;
export const REBALANCE_HISTORY_DEFAULT_MS = 7 * DAY_MS;
export const REBALANCE_ADOPT_LIMIT = 100;
/** Runs whose save failed, kept to be saved again. */
export const REBALANCE_UNSAVED_LIMIT = 500;

export const rebalanceRunId = (
  connectionId: string,
  run: Pick<RebalanceRun, 'sourceShardId' | 'startedAt'>,
): string => `${connectionId}:${run.sourceShardId}:${run.startedAt}`;

/** Compared to skip writes: following a run every few seconds mostly changes nothing. */
export const persistedFingerprint = (run: RebalanceRun): string => JSON.stringify(run);

export function toStoredRun(
  connectionId: string,
  run: RebalanceRun,
  now: number,
): StoredRebalanceRun {
  return {
    id: rebalanceRunId(connectionId, run),
    connectionId,
    sourceShardId: run.sourceShardId,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    updatedAt: now,
    payload: JSON.stringify(run),
  };
}

const isJob = (job: unknown): boolean =>
  typeof job === 'object' && job !== null && !Array.isArray(job);

/** Null for a row that does not parse or does not look like a run: adopting never throws. */
export function fromStoredRun(row: StoredRebalanceRun): RebalanceRun | null {
  try {
    const run = JSON.parse(row.payload) as RebalanceRun | null;
    if (typeof run?.sourceShardId !== 'string' || typeof run.startedAt !== 'number') return null;
    if (!Array.isArray(run.jobs) || !Array.isArray(run.jobsBefore)) return null;
    if (!run.jobs.every(isJob)) return null;
    return run;
  } catch {
    return null;
  }
}

/**
 * `unreadSince` times how long this process could not read a job. Kept across a restart it
 * would count the downtime, and the first incomplete read would end the job as unknown.
 */
const withoutReadTimers = (run: RebalanceRun): RebalanceRun => ({
  ...run,
  jobs: run.jobs.map(({ unreadSince, ...job }) => job),
});

/**
 * A cancel stored as requested but not answered was sent by a process that is gone, so no answer
 * will come: it is followed as accepted, as a cancel that did not answer in time is.
 */
const withCancelSettled = (run: RebalanceRun): RebalanceRun =>
  run.cancelRequestedAt !== undefined && run.cancelAcceptedAt === undefined
    ? { ...run, cancelAcceptedAt: run.cancelRequestedAt }
    : run;

/**
 * The runs to put back into memory: the latest run of each source shard, when it is still
 * running or ended less than `keptMs` ago.
 */
export function runsToAdopt(
  rows: readonly StoredRebalanceRun[],
  now: number,
  keptMs: number,
): RebalanceRun[] {
  const latestBySource = new Map<string, RebalanceRun>();
  for (const row of rows) {
    const run = fromStoredRun(row);
    if (!run) continue;
    const seen = latestBySource.get(run.sourceShardId);
    if (!seen || seen.startedAt < run.startedAt) latestBySource.set(run.sourceShardId, run);
  }
  return [...latestBySource.values()]
    .filter(
      (run) => run.state === 'running' || (run.endedAt !== undefined && now - run.endedAt < keptMs),
    )
    .map((run) => withCancelSettled(withoutReadTimers(run)));
}
