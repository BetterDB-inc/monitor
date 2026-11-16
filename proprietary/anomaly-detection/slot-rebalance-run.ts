import type { ClusterNodeState } from '@betterdb/shared';
import type { ShardLoadSample } from '@app/cluster/shard-load';
import { median } from '../latency-regression/regression-detector';
import { hotShardRatio } from './hot-shard-detector';
import type {
  RebalanceExecutionBlocker,
  RebalancePlan,
  RebalanceVerdict,
} from './rebalance-planner';

export const REBALANCE_JOB_LISTING_GRACE_MS = 60_000;
export const REBALANCE_OUTCOME_SETTLE_MS = 60_000;
export const REBALANCE_RUN_KEPT_MS = 60 * 60_000;
export const REBALANCE_FOLLOW_MS = 5_000;

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

export interface RunReport {
  jobViews: Array<{
    jobName?: string;
    sourceNodeId: string;
    targetNodeId: string;
    slotRange?: string;
    phase?: string;
  }>;
  finishedJobs: string[];
  failed: Array<{
    jobName: string;
    message: string;
    sourceNodeId?: string;
    targetNodeId?: string;
    slotRange?: string;
  }>;
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
}

export interface RebalanceRun extends RebalanceRunView {
  jobsBefore: string[];
  cancelRequestedAt?: number;
}

export function runView(run: RebalanceRun): RebalanceRunView {
  const { jobsBefore, cancelRequestedAt, ...view } = run;
  return view;
}

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
  if (!facts.dialed) return 'not_dialed';
  if (plan.support === 'provider_managed') return 'provider_managed';
  if (plan.support !== 'valkey_atomic') return 'unsupported_server';
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

function slotsOf(text: string | undefined): number[] {
  const slots: number[] = [];
  for (const token of (text ?? '').trim().split(/\s+/)) {
    const [start, end] = token.split('-').map(Number);
    if (!Number.isInteger(start)) return [];
    const last = Number.isInteger(end) ? end : start;
    for (let slot = start; slot <= last; slot++) slots.push(slot);
  }
  return slots;
}

function inside(slots: readonly number[], ranges: ReadonlyArray<readonly [number, number]>) {
  return (
    slots.length > 0 &&
    slots.every((slot) => ranges.some(([start, end]) => slot >= start && slot <= end))
  );
}

function followJob(
  run: RebalanceRun,
  job: RebalanceRunJob,
  report: RunReport,
  byId: ReadonlyMap<string, RunNode>,
  now: number,
): RebalanceRunJob {
  if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') return job;
  const listed = report.jobViews.find(
    (view) =>
      view.jobName !== undefined &&
      view.sourceNodeId === run.sourceShardId &&
      view.targetNodeId === job.targetShardId &&
      (view.jobName === job.jobName || inside(slotsOf(view.slotRange), job.ranges)),
  );
  if (listed) {
    return { ...job, state: 'running', jobName: listed.jobName, phase: listed.phase };
  }
  const moved = owns(byId.get(job.targetShardId), job.ranges);
  if (run.cancelRequestedAt !== undefined && !moved) {
    if (owns(byId.get(run.sourceShardId), job.ranges)) return { ...job, state: 'cancelled' };
    return { ...job, state: 'unknown' };
  }
  const isNew = (jobName: string) => !run.jobsBefore.includes(jobName);
  const failed = report.failed.find((entry) =>
    job.jobName
      ? entry.jobName === job.jobName
      : isNew(entry.jobName) &&
        entry.sourceNodeId === run.sourceShardId &&
        entry.targetNodeId === job.targetShardId &&
        inside(slotsOf(entry.slotRange), job.ranges),
  );
  if (failed) return { ...job, state: 'failed', jobName: failed.jobName, message: failed.message };
  if (!job.jobName && moved) return { ...job, state: 'succeeded' };
  if (job.jobName && report.finishedJobs.includes(job.jobName)) {
    if (moved) return { ...job, state: 'succeeded' };
    if (owns(byId.get(run.sourceShardId), job.ranges)) return { ...job, state: 'cancelled' };
    return { ...job, state: 'unknown' };
  }
  if (!job.jobName && now - run.startedAt <= REBALANCE_JOB_LISTING_GRACE_MS) return job;
  return { ...job, state: 'unknown' };
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
  if (run.state !== 'running') return run;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const jobs = run.jobs.map((job) => followJob(run, job, report, byId, now));
  const state = stateOf(jobs);
  return { ...run, jobs, state, ...(state === 'running' ? {} : { endedAt: now }) };
}

export function withOutcome(run: RebalanceRun, sample: ShardLoadSample | null): RebalanceRun {
  if (run.state !== 'succeeded' || run.outcome || run.endedAt === undefined || !sample) return run;
  if (sample.settling || sample.timestamp < run.endedAt + REBALANCE_OUTCOME_SETTLE_MS) return run;
  const shards = sample.shards.filter((shard) => shard.slotCount > 0);
  const source = shards.find((shard) => shard.nodeId === run.sourceShardId);
  if (!source) return run;
  const cpuMedian = median(shards.map((shard) => shard.cpuUsecPerSecond));
  return {
    ...run,
    outcome: {
      projectedRatio: run.projectedRatio,
      actualRatio: hotShardRatio(source.cpuUsecPerSecond, cpuMedian),
      measuredAt: sample.timestamp,
    },
  };
}

export function isCancelledJob(
  run: RebalanceRun,
  failure: { jobName?: string; sourceNodeId: string; targetNodeId: string; slots: string },
): boolean {
  if (run.cancelRequestedAt === undefined) return false;
  return run.jobs.some((job) =>
    job.jobName !== undefined
      ? job.jobName === failure.jobName
      : failure.jobName !== undefined &&
        !run.jobsBefore.includes(failure.jobName) &&
        failure.sourceNodeId === run.sourceShardId &&
        job.targetShardId === failure.targetNodeId &&
        inside(slotsOf(failure.slots), job.ranges),
  );
}

export function isRunKept(run: RebalanceRun, now: number): boolean {
  return now - (run.endedAt ?? run.startedAt) < REBALANCE_RUN_KEPT_MS;
}
