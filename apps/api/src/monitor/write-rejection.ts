import type { ErrorStatsInfo, PersistenceInfo } from '../common/types/metrics.types';

/**
 * Error codes the server returns when it refuses a write it would otherwise
 * accept. Each is an outage for the application, yet none of them moves
 * memory, CPU or latency, so no existing detector sees them.
 */
export const WRITE_REJECTION_CODES = ['MISCONF', 'OOM', 'READONLY', 'NOREPLICAS'] as const;
export type WriteRejectionCode = (typeof WRITE_REJECTION_CODES)[number];

export type WriteRejectionCause =
  | 'rdb_bgsave_failed'
  | 'aof_write_failed'
  | 'maxmemory_reached'
  | 'write_to_replica'
  | 'min_replicas_not_met';

const CAUSE_BY_CODE: Record<Exclude<WriteRejectionCode, 'MISCONF'>, WriteRejectionCause> = {
  OOM: 'maxmemory_reached',
  READONLY: 'write_to_replica',
  NOREPLICAS: 'min_replicas_not_met',
};

export type WriteRejectionSeverity = 'critical' | 'warning';

export interface WriteRejectionState {
  /** Previous poll's cumulative errorstat counts, keyed by code. */
  lastCounts: Partial<Record<WriteRejectionCode, number>>;
  /** Whether a writes.rejected edge is currently open for this connection. */
  rejecting: boolean;
  rejectingSince: number | null;
  /** Highest severity already reported for the open edge; null while closed. */
  lastSeverity: WriteRejectionSeverity | null;
  /** Every cause already reported for the open edge; empty while closed. */
  lastCauses: WriteRejectionCause[];
}

export function createWriteRejectionState(): WriteRejectionState {
  return {
    lastCounts: {},
    rejecting: false,
    rejectingSince: null,
    lastSeverity: null,
    lastCauses: [],
  };
}

export interface WriteRejectionEvaluation {
  /**
   * 'rejected' when the edge opens, 'escalated' when an open edge turns
   * critical or gains a cause, 'recovered' when it closes; null otherwise.
   */
  transition: 'rejected' | 'escalated' | 'recovered' | null;
  /** 'critical' once clients actually received the error, 'warning' while only at risk. */
  severity: WriteRejectionSeverity;
  causes: WriteRejectionCause[];
  /** Errors returned to clients since the previous poll, by code. */
  rejectedSinceLastPoll: Partial<Record<WriteRejectionCode, number>>;
  rejectingForMs: number | null;
}

/**
 * Cumulative count for one code. The server lists only codes it has returned
 * at least once, so an absent entry in a present section means 0. null for an
 * entry the parser could not read, which leaves that code's baseline alone.
 */
function countOf(errorstats: ErrorStatsInfo, code: WriteRejectionCode): number | null {
  const entry = errorstats[`errorstat_${code}`];
  if (entry === undefined) return 0;
  return typeof entry === 'object' ? entry.count : null;
}

/**
 * One poll. Two independent signals, so the edge opens even before the first
 * client hits the error (quiet period) and is confirmed once one does:
 *
 *  - persistence status: `rdb_last_bgsave_status:err` (writes are refused with
 *    MISCONF when stop-writes-on-bgsave-error=yes, the default) or
 *    `aof_last_write_status:err` (always refused);
 *  - errorstats deltas: errorstat_MISCONF/OOM/READONLY/NOREPLICAS rising.
 *
 * Counters are cumulative and reset on restart or CONFIG RESETSTAT, so a drop
 * re-baselines instead of reading as a negative delta. A poll without the
 * errorstats section keeps the previous baseline, so the next poll that has
 * it still sees the whole delta. Recovery needs both signals clean on the
 * same poll.
 *
 * While the edge is open, it escalates once when severity first reaches
 * critical and once per cause not yet reported; staying critical, or causes
 * repeating or shrinking, stays quiet.
 */
export function evaluateWriteRejection(
  state: WriteRejectionState,
  persistence: Partial<PersistenceInfo> | undefined,
  errorstats: ErrorStatsInfo | undefined,
  now: number,
): WriteRejectionEvaluation {
  const causes = new Set<WriteRejectionCause>();
  const rejectedSinceLastPoll: Partial<Record<WriteRejectionCode, number>> = {};

  if (persistence?.rdb_last_bgsave_status === 'err') causes.add('rdb_bgsave_failed');
  if (persistence?.aof_last_write_status === 'err') causes.add('aof_write_failed');

  if (errorstats !== undefined) {
    for (const code of WRITE_REJECTION_CODES) {
      const count = countOf(errorstats, code);
      if (count === null) continue;
      const previous = state.lastCounts[code];
      state.lastCounts[code] = count;
      if (previous === undefined || count < previous) continue; // first sight or counter reset
      const delta = count - previous;
      if (delta === 0) continue;
      rejectedSinceLastPoll[code] = delta;
      if (code === 'MISCONF') {
        if (causes.size === 0) causes.add('rdb_bgsave_failed');
      } else {
        causes.add(CAUSE_BY_CODE[code]);
      }
    }
  }

  const severity: WriteRejectionSeverity =
    Object.keys(rejectedSinceLastPoll).length > 0 ? 'critical' : 'warning';
  const active = causes.size > 0;
  let transition: WriteRejectionEvaluation['transition'] = null;

  if (active && state.rejecting === false) {
    state.rejecting = true;
    state.rejectingSince = now;
    state.lastSeverity = severity;
    state.lastCauses = [...causes];
    transition = 'rejected';
  } else if (active && state.rejecting === true) {
    const reported = new Set(state.lastCauses);
    const newCauses = [...causes].filter((cause) => !reported.has(cause));
    const turnedCritical = severity === 'critical' && state.lastSeverity === 'warning';
    if (turnedCritical || newCauses.length > 0) {
      if (turnedCritical) state.lastSeverity = 'critical';
      state.lastCauses = [...state.lastCauses, ...newCauses];
      transition = 'escalated';
    }
  } else if (active === false && state.rejecting === true) {
    transition = 'recovered';
  }

  const rejectingForMs = state.rejectingSince === null ? null : now - state.rejectingSince;
  if (transition === 'recovered') {
    state.rejecting = false;
    state.rejectingSince = null;
    state.lastSeverity = null;
    state.lastCauses = [];
  }

  return {
    transition,
    severity,
    causes: [...causes],
    rejectedSinceLastPoll,
    rejectingForMs,
  };
}
