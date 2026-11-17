import { clusterNodeState, type ClusterNodeState } from '@betterdb/shared';
import type { ClusterNode } from '@app/common/types/metrics.types';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import { median } from '../latency-regression/regression-detector';
import { hotShardRatio } from './hot-shard-detector';
import { mergeSlotRanges, parseSlotRangeList } from './topology-divergence';
import type {
  RebalanceExecutionBlocker,
  RebalancePlan,
  RebalanceVerdict,
} from './rebalance-planner';

export const REBALANCE_JOB_LISTING_GRACE_MS = 60_000;
export const REBALANCE_OUTCOME_SETTLE_MS = 60_000;
export const REBALANCE_OUTCOME_WAIT_MS = 10 * 60_000;
export const REBALANCE_RUN_KEPT_MS = 60 * 60_000;
export const REBALANCE_FOLLOW_MS = 5_000;
export const REBALANCE_CANCEL_PENDING_MS = 10_000;

export type RebalanceRecheckFailure = 'slots_moved' | 'source_unhealthy' | 'target_unhealthy';

export interface ConfirmedMove {
  targetShardId: string;
  ranges: Array<[number, number]>;
}

export interface RunNode {
  id: string;
  role: 'master' | 'replica';
  state: ClusterNodeState;
  slots: number[][];
}

export const runNodesOf = (nodes: readonly ClusterNode[]): RunNode[] =>
  nodes.flatMap((node) => {
    const master = node.flags.includes('master');
    if (!master && !node.flags.includes('slave') && !node.flags.includes('replica')) return [];
    return [
      {
        id: node.id,
        role: master ? 'master' : 'replica',
        state: clusterNodeState(node.flags),
        slots: node.slots,
      },
    ];
  });

export interface RunReport {
  jobViews: Array<{
    jobName?: string;
    sourceNodeId: string;
    targetNodeId: string;
    slotRange?: string;
    phase?: string;
  }>;
  finishedJobs: string[];
  cancelledJobs?: string[];
  failed: Array<{
    jobName: string;
    message: string;
    sourceNodeId?: string;
    targetNodeId?: string;
    slotRange?: string;
  }>;
  complete?: boolean;
  jobsReadNodeIds?: readonly string[];
}

export type RebalanceJobState =
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface RebalanceRunJob {
  targetShardId: string;
  targetAddr: string;
  ranges: Array<[number, number]>;
  state: RebalanceJobState;
  jobName?: string;
  phase?: string;
  message?: string;
}

export type RebalanceRunState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export interface RebalanceRunActor {
  userId: string | null;
  email: string | null;
}

export interface RebalanceRunView {
  sourceShardId: string;
  sourceAddr: string;
  startedBy: RebalanceRunActor;
  startedAt: number;
  projectedRatio: number;
  jobs: RebalanceRunJob[];
  state: RebalanceRunState;
  endedAt?: number;
  outcome?: { projectedRatio: number; actualRatio: number; measuredAt: number };
  outcomeUnavailable?: boolean;
}

export interface RunJob extends RebalanceRunJob {
  finishedSeenAt?: number;
  unreadSince?: number;
}

export interface RebalanceRun extends RebalanceRunView {
  jobs: RunJob[];
  jobsBefore: string[];
  failedBeforeCancel?: string[];
  cancelRequestedAt?: number;
  cancelAcceptedAt?: number;
}

export function runView(run: RebalanceRun): RebalanceRunView {
  const { jobsBefore, failedBeforeCancel, cancelRequestedAt, cancelAcceptedAt, jobs, ...view } =
    run;
  return { ...view, jobs: jobs.map(({ finishedSeenAt, unreadSince, ...job }) => job) };
}

export const isCancelPending = (run: RebalanceRun, now: number) =>
  run.cancelRequestedAt !== undefined &&
  run.cancelAcceptedAt === undefined &&
  now - run.cancelRequestedAt < REBALANCE_CANCEL_PENDING_MS;

export type RebalanceRunResult =
  | { status: 'started'; run: RebalanceRunView }
  | { status: 'blocked'; blockedBy: RebalanceExecutionBlocker }
  | {
      status: 'changed';
      reason: 'no_plan' | 'plan_changed' | RebalanceRecheckFailure;
      rebalance?: RebalanceVerdict;
    }
  | { status: 'refused'; message: string };

export type RebalanceCancelResult =
  | { status: 'cancelling'; run: RebalanceRunView }
  | { status: 'blocked'; blockedBy: RebalanceExecutionBlocker }
  | { status: 'not_running' }
  | { status: 'refused'; message: string };

export function executionBlocker(
  plan: RebalancePlan,
  facts: { enabled: boolean; dialed: boolean; migrationRunning: boolean },
): RebalanceExecutionBlocker | undefined {
  if (!facts.enabled) return 'flag_off';
  if (plan.support === 'provider_managed') return 'provider_managed';
  if (plan.support !== 'valkey_atomic') return 'unsupported_server';
  if (!facts.dialed) return 'not_dialed';
  if (facts.migrationRunning) return 'migration_running';
  return undefined;
}

const rangeKey = (ranges: ReadonlyArray<readonly [number, number]>) =>
  ranges.map(([start, end]) => `${start}-${end}`).join(',');

export function sameMoves(plan: RebalancePlan, confirmed: readonly ConfirmedMove[]): boolean {
  return (
    plan.moves.length === confirmed.length &&
    plan.moves.every(
      (move, index) =>
        move.targetShardId === confirmed[index].targetShardId &&
        rangeKey(move.ranges) === rangeKey(confirmed[index].ranges),
    )
  );
}

const MAX_SLOT = 16383;

const isSlotRange = (range: unknown): range is [number, number] =>
  Array.isArray(range) &&
  range.length === 2 &&
  range.every((slot) => Number.isInteger(slot) && slot >= 0 && slot <= MAX_SLOT) &&
  range[0] <= range[1];

export function parseConfirmedMoves(body: unknown): ConfirmedMove[] | null {
  const moves = (body as { moves?: unknown } | null)?.moves;
  if (!Array.isArray(moves) || moves.length === 0) return null;
  const parsed: ConfirmedMove[] = [];
  for (const move of moves) {
    const { targetShardId, ranges } = (move ?? {}) as { targetShardId?: unknown; ranges?: unknown };
    if (typeof targetShardId !== 'string' || targetShardId === '') return null;
    if (!Array.isArray(ranges) || ranges.length === 0 || !ranges.every(isSlotRange)) return null;
    parsed.push({ targetShardId, ranges: ranges.map(([start, end]) => [start, end]) });
  }
  return parsed;
}

export function migrateSlotsArgs(plan: RebalancePlan): string[] {
  return [
    'MIGRATESLOTS',
    ...plan.moves.flatMap((move) => [
      'SLOTSRANGE',
      ...move.ranges.flatMap(([start, end]) => [String(start), String(end)]),
      'NODE',
      move.targetShardId,
    ]),
  ];
}

const owns = (node: RunNode | undefined, ranges: ReadonlyArray<readonly [number, number]>) =>
  node !== undefined &&
  ranges.every(([start, end]) =>
    node.slots.some(([from, to]) => start >= from && end <= (to ?? from)),
  );

const isHealthyPrimary = (node: RunNode | undefined) =>
  node !== undefined && node.role === 'master' && node.state === 'healthy';

export function recheckFailure(
  plan: RebalancePlan,
  nodes: readonly RunNode[],
): RebalanceRecheckFailure | undefined {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const source = byId.get(plan.sourceShardId);
  if (!isHealthyPrimary(source)) return 'source_unhealthy';
  if (!owns(source, plan.moves.flatMap((move) => move.ranges))) return 'slots_moved';
  if (plan.moves.some((move) => !isHealthyPrimary(byId.get(move.targetShardId)))) {
    return 'target_unhealthy';
  }
  return undefined;
}

export function startRun(
  plan: RebalancePlan,
  startedBy: RebalanceRunActor,
  now: number,
  jobsBefore: readonly string[] = [],
): RebalanceRun {
  const source = plan.projection.find((row) => row.role === 'source');
  return {
    sourceShardId: plan.sourceShardId,
    sourceAddr: source?.nodeAddr ?? '',
    startedBy,
    startedAt: now,
    projectedRatio: source?.after.ratio ?? 0,
    jobsBefore: [...jobsBefore],
    jobs: plan.moves.map((move) => ({
      targetShardId: move.targetShardId,
      targetAddr: move.targetAddr,
      ranges: move.ranges,
      state: 'starting',
    })),
    state: 'running',
  };
}

function inside(text: string | undefined, ranges: ReadonlyArray<readonly [number, number]>) {
  const listed = parseSlotRangeList(text);
  const own = mergeSlotRanges(ranges);
  return (
    listed.length > 0 &&
    listed.every(([start, end]) => own.some(([from, to]) => start >= from && end <= to))
  );
}

const failedOnItsOwn = (run: RebalanceRun, jobName: string) =>
  run.cancelAcceptedAt === undefined || (run.failedBeforeCancel ?? []).includes(jobName);

interface JobEntry {
  jobName?: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  slotRange?: string;
}

function matchesJob(run: RebalanceRun, job: RebalanceRunJob, entry: JobEntry): boolean {
  return (
    entry.jobName !== undefined &&
    !run.jobsBefore.includes(entry.jobName) &&
    entry.sourceNodeId === run.sourceShardId &&
    entry.targetNodeId === job.targetShardId &&
    inside(entry.slotRange, job.ranges)
  );
}

const isRunJob = (run: RebalanceRun, job: RebalanceRunJob, entry: JobEntry) =>
  job.jobName ? entry.jobName === job.jobName : matchesJob(run, job, entry);

const findFailure = (run: RebalanceRun, job: RunJob, report: RunReport) =>
  report.failed.find((entry) => isRunJob(run, job, entry));

const cancelledByServer = (job: RunJob, report: RunReport) =>
  job.jobName !== undefined && (report.cancelledJobs ?? []).includes(job.jobName);

const mayHaveSucceeded = (job: RunJob, report: RunReport, failed: unknown) =>
  !failed &&
  (job.finishedSeenAt !== undefined ||
    (job.jobName !== undefined && report.finishedJobs.includes(job.jobName)));

function listedJob(run: RebalanceRun, job: RunJob, report: RunReport): RunJob | undefined {
  const listed = report.jobViews.find(
    (view) =>
      view.jobName !== undefined &&
      view.sourceNodeId === run.sourceShardId &&
      view.targetNodeId === job.targetShardId &&
      isRunJob(run, job, view),
  );
  if (listed?.jobName === undefined) return undefined;
  return { ...job, state: 'running', jobName: listed.jobName, phase: listed.phase };
}

function followJob(
  run: RebalanceRun,
  job: RunJob,
  report: RunReport,
  byId: ReadonlyMap<string, RunNode>,
  now: number,
): RunJob {
  if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job;
  const listed = listedJob(run, job, report);
  if (listed) return listed;
  const moved = owns(byId.get(job.targetShardId), job.ranges);
  const sourceOwns = owns(byId.get(run.sourceShardId), job.ranges);
  const failed = findFailure(run, job, report);
  const failedJob = failed && {
    ...job,
    state: 'failed' as const,
    jobName: failed.jobName,
    message: failed.message,
  };
  if (failedJob && failedOnItsOwn(run, failedJob.jobName)) return failedJob;
  if (run.cancelAcceptedAt !== undefined && !moved) {
    if (cancelledByServer(job, report)) return { ...job, state: 'cancelled' };
    if (!mayHaveSucceeded(job, report, failed)) {
      return { ...job, state: sourceOwns ? 'cancelled' : 'unknown' };
    }
  }
  if (failedJob) return failedJob;
  if (moved) return { ...job, state: 'succeeded' };
  if (job.jobName && report.finishedJobs.includes(job.jobName)) {
    const finishedSeenAt = job.finishedSeenAt ?? now;
    if (now - finishedSeenAt < REBALANCE_JOB_LISTING_GRACE_MS) return { ...job, finishedSeenAt };
    return { ...job, state: sourceOwns ? 'cancelled' : 'unknown' };
  }
  if (!job.jobName && now - run.startedAt <= REBALANCE_JOB_LISTING_GRACE_MS) return job;
  return { ...job, state: 'unknown' };
}

function followOwnership(
  run: RebalanceRun,
  job: RunJob,
  report: RunReport,
  byId: ReadonlyMap<string, RunNode>,
  now: number,
): RunJob {
  if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job;
  const { unreadSince, ...seen } = job;
  const listed = listedJob(run, seen, report);
  if (listed) return listed;
  const failed = findFailure(run, job, report);
  if (failed && failedOnItsOwn(run, failed.jobName)) {
    return { ...job, state: 'failed', jobName: failed.jobName, message: failed.message };
  }
  if (owns(byId.get(job.targetShardId), job.ranges)) return { ...job, state: 'succeeded' };
  if (run.cancelAcceptedAt !== undefined) {
    const sourceOwns = owns(byId.get(run.sourceShardId), job.ranges);
    if (cancelledByServer(job, report) || (sourceOwns && !mayHaveSucceeded(job, report, failed))) {
      return { ...job, state: 'cancelled' };
    }
  }
  const since = unreadSince ?? now;
  if (now - since >= REBALANCE_JOB_LISTING_GRACE_MS) return { ...job, state: 'unknown' };
  return { ...job, unreadSince: since };
}

function stateOf(jobs: readonly RebalanceRunJob[]): RebalanceRunState {
  const states = new Set(jobs.map((job) => job.state));
  if (states.has('starting') || states.has('running')) return 'running';
  if (states.has('failed')) return 'failed';
  if (states.has('cancelled')) return 'cancelled';
  if (states.has('unknown')) return 'unknown';
  return 'succeeded';
}

export function followRun(
  run: RebalanceRun,
  report: RunReport,
  nodes: readonly RunNode[],
  now: number,
): RebalanceRun {
  if (run.state !== 'running' || isCancelPending(run, now)) return run;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const jobsRead = (job: RunJob) =>
    report.complete !== false ||
    [run.sourceShardId, job.targetShardId].every((id) => report.jobsReadNodeIds?.includes(id));
  const jobs = run.jobs.map(({ unreadSince, ...job }) =>
    jobsRead(job)
      ? followJob(run, job, report, byId, now)
      : followOwnership(run, { ...job, unreadSince }, report, byId, now),
  );
  const state = stateOf(jobs);
  return { ...run, jobs, state, ...(state === 'running' ? {} : { endedAt: now }) };
}

function measuredOutcome(
  run: RebalanceRun,
  endedAt: number,
  sample: ShardLoadSample | null,
): RebalanceRun['outcome'] {
  if (!sample || sample.settling || sample.timestamp < endedAt + REBALANCE_OUTCOME_SETTLE_MS) {
    return undefined;
  }
  const shards = sample.shards.filter((shard) => shard.slotCount > 0);
  const source = shards.find((shard) => shard.nodeId === run.sourceShardId);
  if (!source) return undefined;
  const cpuMedian = median(shards.map((shard) => shard.cpuUsecPerSecond));
  return {
    projectedRatio: run.projectedRatio,
    actualRatio: hotShardRatio(source.cpuUsecPerSecond, cpuMedian),
    measuredAt: sample.timestamp,
  };
}

export function withOutcome(
  run: RebalanceRun,
  sample: ShardLoadSample | null,
  now: number,
): RebalanceRun {
  if (run.state !== 'succeeded' || run.outcome || run.outcomeUnavailable) return run;
  if (run.endedAt === undefined) return run;
  const outcome = measuredOutcome(run, run.endedAt, sample);
  if (outcome) return { ...run, outcome };
  if (now - run.endedAt >= REBALANCE_OUTCOME_WAIT_MS) return { ...run, outcomeUnavailable: true };
  return run;
}

export function cancelledFailure(
  run: RebalanceRun,
  failure: { jobName?: string; sourceNodeId: string; targetNodeId: string; slots: string },
  now: number,
): 'cancelled' | 'cancel_pending' | undefined {
  if (run.cancelRequestedAt === undefined) return undefined;
  if (failure.jobName !== undefined && run.failedBeforeCancel?.includes(failure.jobName)) {
    return undefined;
  }
  const recent = run.endedAt === undefined || now - run.endedAt < REBALANCE_JOB_LISTING_GRACE_MS;
  const entry = { ...failure, slotRange: failure.slots };
  const own = run.jobs.some(
    (job) =>
      job.state !== 'failed' &&
      (job.jobName !== undefined ? job.jobName === failure.jobName : recent && matchesJob(run, job, entry)),
  );
  if (!own) return undefined;
  return run.cancelAcceptedAt === undefined ? 'cancel_pending' : 'cancelled';
}

export function isRunKept(run: RebalanceRun, now: number): boolean {
  return run.endedAt === undefined || now - run.endedAt < REBALANCE_RUN_KEPT_MS;
}

