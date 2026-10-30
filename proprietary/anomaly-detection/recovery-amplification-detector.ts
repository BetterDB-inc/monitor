import { registerSequenceRule } from './sequence-rules';
import { ReplicationStreamSample } from './replication-stream';
import { AnomalyPattern, MetricType } from './types';

export const BACKLOG_COVERAGE_WARNING_SEC = 60;
export const BACKLOG_COVERAGE_CRITICAL_SEC = 15;
export const BACKLOG_COVERAGE_POLLS = 3;
export const BACKLOG_COVERAGE_REARM_FACTOR = 1.2;
export const BACKLOG_COVERAGE_MIN_BYTES_PER_SEC = 1024;
export const RESYNC_ESCALATION_WINDOW_MS = 5 * 60_000;
export const RECOVERY_AMPLIFICATION_MAX_SPAN_MS = 10 * 60_000;

export type BacklogCoverageLevel = 'none' | 'warning' | 'critical';

const LEVEL_RANK: Record<BacklogCoverageLevel, number> = { none: 0, warning: 1, critical: 2 };

export interface BacklogCoverageState {
  level: BacklogCoverageLevel;
  belowWarning: number;
  belowCritical: number;
}

export interface BacklogCoverageStep {
  escalatedTo: BacklogCoverageLevel | null;
  cleared: boolean;
}

export function createBacklogCoverageState(): BacklogCoverageState {
  return { level: 'none', belowWarning: 0, belowCritical: 0 };
}

export function backlogCoverageSec(sample: ReplicationStreamSample): number | null {
  if (sample.role !== 'primary' || sample.replicas.length === 0) return Number.POSITIVE_INFINITY;
  const { replBacklogHistlen, bytesPerSec, bytesPerSecEwma } = sample;
  if (replBacklogHistlen === null || bytesPerSec === null || bytesPerSecEwma === null) return null;
  if (bytesPerSecEwma <= BACKLOG_COVERAGE_MIN_BYTES_PER_SEC) return Number.POSITIVE_INFINITY;
  return replBacklogHistlen / Math.max(bytesPerSec, bytesPerSecEwma);
}

export function stepBacklogCoverage(
  state: BacklogCoverageState,
  coverageSec: number | null,
): BacklogCoverageStep {
  if (coverageSec === null) return { escalatedTo: null, cleared: false };

  state.belowWarning = coverageSec < BACKLOG_COVERAGE_WARNING_SEC ? state.belowWarning + 1 : 0;
  state.belowCritical = coverageSec < BACKLOG_COVERAGE_CRITICAL_SEC ? state.belowCritical + 1 : 0;

  if (coverageSec > BACKLOG_COVERAGE_WARNING_SEC * BACKLOG_COVERAGE_REARM_FACTOR) {
    const cleared = state.level !== 'none';
    state.level = 'none';
    return { escalatedTo: null, cleared };
  }

  const target: BacklogCoverageLevel =
    state.belowCritical >= BACKLOG_COVERAGE_POLLS
      ? 'critical'
      : state.belowWarning >= BACKLOG_COVERAGE_POLLS
        ? 'warning'
        : 'none';
  if (LEVEL_RANK[target] <= LEVEL_RANK[state.level]) return { escalatedTo: null, cleared: false };
  state.level = target;
  return { escalatedTo: target, cleared: false };
}

export interface SyncCounters {
  full: number;
  partialOk: number;
  partialErr: number;
}

interface PendingDisconnect {
  disconnectAt: number;
  coverageSec: number | null;
  counters: SyncCounters;
}

export interface ResyncEscalationState {
  online: Set<string>;
  pending: Map<string, PendingDisconnect>;
  counters: SyncCounters | null;
  coverageSec: number | null;
}

export interface ResyncEscalation {
  addr: string;
  disconnectedForMs: number;
  coverageSec: number | null;
  fullSyncs: number;
  partialSyncErrors: number;
}

export function createResyncEscalationState(): ResyncEscalationState {
  return { online: new Set(), pending: new Map(), counters: null, coverageSec: null };
}

function movedSince(before: SyncCounters, after: SyncCounters): SyncCounters {
  return {
    full: Math.max(0, after.full - before.full),
    partialOk: Math.max(0, after.partialOk - before.partialOk),
    partialErr: Math.max(0, after.partialErr - before.partialErr),
  };
}

export function observeResyncEscalation(
  state: ResyncEscalationState,
  sample: ReplicationStreamSample,
  counters: SyncCounters,
  coverageSec: number | null,
): ResyncEscalation[] {
  const online = new Set(sample.replicas.filter((r) => r.state === 'online').map((r) => r.addr));
  const baseline = state.counters ?? counters;

  for (const addr of state.online) {
    if (online.has(addr) || state.pending.has(addr)) continue;
    state.pending.set(addr, {
      disconnectAt: sample.timestamp,
      coverageSec: state.coverageSec,
      counters: baseline,
    });
  }

  const escalations: ResyncEscalation[] = [];
  for (const [addr, disconnect] of state.pending) {
    if (sample.timestamp - disconnect.disconnectAt > RESYNC_ESCALATION_WINDOW_MS) {
      state.pending.delete(addr);
      continue;
    }
    if (!online.has(addr)) continue;
    state.pending.delete(addr);
    const moved = movedSince(disconnect.counters, counters);
    if (moved.full > 0 || moved.partialErr > 0) {
      escalations.push({
        addr,
        disconnectedForMs: sample.timestamp - disconnect.disconnectAt,
        coverageSec: disconnect.coverageSec,
        fullSyncs: moved.full,
        partialSyncErrors: moved.partialErr,
      });
    }
  }

  state.online = online;
  state.counters = counters;
  if (coverageSec !== null) state.coverageSec = coverageSec;
  return escalations;
}

registerSequenceRule({
  pattern: AnomalyPattern.RECOVERY_AMPLIFICATION,
  steps: [
    [MetricType.RESYNC_ESCALATION],
    [
      MetricType.FORK_MEMORY_RISK,
      MetricType.REPL_BUFFER_PRESSURE,
      MetricType.MEMORY_USED,
      MetricType.MEMORY_OVERHEAD,
      MetricType.OUTPUT_KBPS,
    ],
  ],
  maxSpanMs: RECOVERY_AMPLIFICATION_MAX_SPAN_MS,
  diagnosis:
    'A replica disconnect outran the replication backlog and forced a full resync, and the primary then took the fork, memory or output-buffer cost of serving it.',
  recommendations: [
    'Raise repl-backlog-size so a disconnect of this length resumes with a partial sync',
    'Check why the replica disconnected before the next write burst repeats it',
    'Watch fork memory and replica output buffers until the resync completes',
  ],
});
