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

const FULL_SYNC_REPLICA_STATES: ReadonlySet<string> = new Set(['wait_bgsave', 'send_bulk']);

export type BacklogCoverageLevel = 'none' | 'warning' | 'critical';

const LEVEL_RANK: Record<BacklogCoverageLevel, number> = { none: 0, warning: 1, critical: 2 };

export interface BacklogCoverageState {
  level: BacklogCoverageLevel;
  belowWarning: number;
  belowCritical: number;
  noReplicasSince: number | null;
}

export interface BacklogCoverageStep {
  escalatedTo: BacklogCoverageLevel | null;
  cleared: boolean;
}

export function createBacklogCoverageState(): BacklogCoverageState {
  return { level: 'none', belowWarning: 0, belowCritical: 0, noReplicasSince: null };
}

export function backlogCoverageSec(sample: ReplicationStreamSample): number | null {
  if (sample.role !== 'primary') return Number.POSITIVE_INFINITY;
  if (sample.replicas.length === 0) return null;
  const { replBacklogSize, bytesPerSec, bytesPerSecEwma } = sample;
  if (replBacklogSize === null || bytesPerSec === null || bytesPerSecEwma === null) return null;
  if (bytesPerSecEwma <= BACKLOG_COVERAGE_MIN_BYTES_PER_SEC) return Number.POSITIVE_INFINITY;
  return replBacklogSize / Math.max(bytesPerSec, bytesPerSecEwma);
}

export function observeBacklogCoverage(
  state: BacklogCoverageState,
  sample: ReplicationStreamSample,
): number | null {
  if (sample.role !== 'primary' || sample.replicas.length > 0) {
    state.noReplicasSince = null;
    return backlogCoverageSec(sample);
  }
  state.noReplicasSince ??= sample.timestamp;
  return sample.timestamp - state.noReplicasSince > RESYNC_ESCALATION_WINDOW_MS
    ? Number.POSITIVE_INFINITY
    : null;
}

export function backlogCoverageRecovered(coverageSec: number | null): boolean {
  return (
    coverageSec !== null &&
    coverageSec > BACKLOG_COVERAGE_WARNING_SEC * BACKLOG_COVERAGE_REARM_FACTOR
  );
}

export function stepBacklogCoverage(
  state: BacklogCoverageState,
  coverageSec: number | null,
): BacklogCoverageStep {
  if (coverageSec === null) return { escalatedTo: null, cleared: false };

  state.belowWarning = coverageSec < BACKLOG_COVERAGE_WARNING_SEC ? state.belowWarning + 1 : 0;
  state.belowCritical = coverageSec < BACKLOG_COVERAGE_CRITICAL_SEC ? state.belowCritical + 1 : 0;

  if (backlogCoverageRecovered(coverageSec)) {
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
  attributedFullSyncs: number;
}

export interface ResyncEscalationState {
  online: Set<string>;
  syncing: Set<string>;
  pending: Map<string, PendingDisconnect>;
  counters: SyncCounters | null;
  coverageSec: number | null;
  attributedFullSyncs: number;
}

export interface ResyncEscalation {
  addr: string;
  occurredAt: number;
  disconnectedForMs: number;
  coverageSec: number | null;
  fullSyncs: number;
  partialSyncErrors: number;
  syncState: string | null;
}

export function createResyncEscalationState(): ResyncEscalationState {
  return {
    online: new Set(),
    syncing: new Set(),
    pending: new Map(),
    counters: null,
    coverageSec: null,
    attributedFullSyncs: 0,
  };
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
      attributedFullSyncs: state.attributedFullSyncs,
    });
  }

  const syncing = new Set<string>();
  const escalations: ResyncEscalation[] = [];
  for (const { addr, state: syncState } of sample.replicas) {
    if (!FULL_SYNC_REPLICA_STATES.has(syncState)) continue;
    syncing.add(addr);
    if (!state.syncing.has(addr)) state.attributedFullSyncs += 1;
    const disconnect = state.pending.get(addr);
    if (!disconnect) continue;
    state.pending.delete(addr);
    escalations.push({
      addr,
      occurredAt: sample.timestamp,
      disconnectedForMs: sample.timestamp - disconnect.disconnectAt,
      coverageSec: disconnect.coverageSec,
      fullSyncs: 1,
      partialSyncErrors: 0,
      syncState,
    });
  }

  for (const addr of online) {
    if (!state.online.has(addr) && !state.pending.has(addr) && !state.syncing.has(addr)) {
      state.attributedFullSyncs += 1;
    }
  }

  for (const [addr, disconnect] of state.pending) {
    if (sample.timestamp - disconnect.disconnectAt > RESYNC_ESCALATION_WINDOW_MS) {
      state.pending.delete(addr);
      continue;
    }
    if (!online.has(addr)) continue;
    state.pending.delete(addr);
    const moved = movedSince(disconnect.counters, counters);
    const attributed = state.attributedFullSyncs - disconnect.attributedFullSyncs;
    const fullSyncs = moved.full - attributed;
    const partialSyncErrors = moved.partialErr - attributed;
    if (fullSyncs > 0 || partialSyncErrors > 0) {
      state.attributedFullSyncs += Math.max(0, fullSyncs);
      escalations.push({
        addr,
        occurredAt: disconnect.disconnectAt,
        disconnectedForMs: sample.timestamp - disconnect.disconnectAt,
        coverageSec: disconnect.coverageSec,
        fullSyncs: Math.max(0, fullSyncs),
        partialSyncErrors: Math.max(0, partialSyncErrors),
        syncState: null,
      });
    }
  }

  state.online = online;
  state.syncing = syncing;
  state.counters = counters;
  if (coverageSec !== null) state.coverageSec = coverageSec;
  return escalations;
}

export function resyncSettled(
  sample: ReplicationStreamSample,
  addr: string | null,
  since: number,
): boolean {
  if (sample.role !== 'primary') return true;
  const replica = sample.replicas.find((r) => r.addr === addr);
  return replica
    ? replica.state === 'online'
    : sample.timestamp - since > RESYNC_ESCALATION_WINDOW_MS;
}

export function resyncEventReplica(message: string): string | null {
  return /^Replica (\S+) /.exec(message)?.[1] ?? null;
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
  sameConnection: true,
  diagnosis:
    'A replica disconnect outran the replication backlog and forced a full resync, and the primary then took the fork, memory or output-buffer cost of serving it.',
  recommendations: [
    'Raise repl-backlog-size so a disconnect of this length resumes with a partial sync',
    'Check why the replica disconnected before the next write burst repeats it',
    'Watch fork memory and replica output buffers until the resync completes',
  ],
});
