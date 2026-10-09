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

export interface WriteRejectionState {
  /** Previous poll's cumulative errorstat counts, keyed by code. */
  lastCounts: Partial<Record<WriteRejectionCode, number>>;
  /** Whether a writes.rejected edge is currently open for this connection. */
  rejecting: boolean;
  rejectingSince: number | null;
}

export function createWriteRejectionState(): WriteRejectionState {
  return { lastCounts: {}, rejecting: false, rejectingSince: null };
}

export interface WriteRejectionEvaluation {
  /** 'rejected' / 'recovered' on an edge; null when nothing changed. */
  transition: 'rejected' | 'recovered' | null;
  /** 'critical' once clients actually received the error, 'warning' while only at risk. */
  severity: 'critical' | 'warning';
  causes: WriteRejectionCause[];
  /** Errors returned to clients since the previous poll, by code. */
  rejectedSinceLastPoll: Partial<Record<WriteRejectionCode, number>>;
  rejectingForMs: number | null;
}

function countOf(errorstats: ErrorStatsInfo | undefined, code: WriteRejectionCode): number | null {
  const entry = errorstats?.[`errorstat_${code}`];
  return entry !== undefined && typeof entry === 'object' ? entry.count : null;
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
 * re-baselines instead of reading as a negative delta. Recovery needs both
 * signals clean on the same poll.
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

  for (const code of WRITE_REJECTION_CODES) {
    const count = countOf(errorstats, code);
    const previous = state.lastCounts[code];
    if (count === null) {
      delete state.lastCounts[code];
      continue;
    }
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

  const clientsAffected = Object.keys(rejectedSinceLastPoll).length > 0;
  const active = causes.size > 0;
  let transition: WriteRejectionEvaluation['transition'] = null;

  if (active && state.rejecting === false) {
    state.rejecting = true;
    state.rejectingSince = now;
    transition = 'rejected';
  } else if (active === false && state.rejecting === true) {
    transition = 'recovered';
  }

  const rejectingForMs = state.rejectingSince === null ? null : now - state.rejectingSince;
  if (transition === 'recovered') {
    state.rejecting = false;
    state.rejectingSince = null;
  }

  return {
    transition,
    severity: clientsAffected ? 'critical' : 'warning',
    causes: [...causes],
    rejectedSinceLastPoll,
    rejectingForMs,
  };
}
