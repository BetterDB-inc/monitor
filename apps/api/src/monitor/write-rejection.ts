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
  | 'min_replicas_not_met'
  /** MISCONF seen but the failing persistence status cleared before the poll. */
  | 'persistence_failed';

const CAUSE_BY_CODE: Record<Exclude<WriteRejectionCode, 'MISCONF'>, WriteRejectionCause> = {
  OOM: 'maxmemory_reached',
  READONLY: 'write_to_replica',
  NOREPLICAS: 'min_replicas_not_met',
};

export type WriteRejectionSeverity = 'critical' | 'warning';

/**
 * How long an open edge must see no active cause before it closes. OOM,
 * READONLY and NOREPLICAS have no persistent "still broken" flag, so one quiet
 * poll proves nothing. Time-based rather than a poll count because /metrics
 * scrapes run the same pass at an unpredictable rate.
 */
export const RECOVERY_QUIET_MS = 60_000;

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
  /** When the open edge last saw an active cause; recovery waits quietMs after it. */
  lastActiveAt: number | null;
}

export function createWriteRejectionState(): WriteRejectionState {
  return {
    lastCounts: {},
    rejecting: false,
    rejectingSince: null,
    lastSeverity: null,
    lastCauses: [],
    lastActiveAt: null,
  };
}

export interface WriteRejectionInput {
  persistence: Partial<PersistenceInfo> | undefined;
  errorstats: ErrorStatsInfo | undefined;
  /** INFO replication role; 'slave'/'replica' means READONLY is expected. */
  role?: string;
  /** used_memory and maxmemory from INFO memory (0/undefined = unlimited/unknown). */
  usedMemory?: number;
  maxMemory?: number;
  /** INFO memory mem_not_counted_for_evict (replica output / AOF buffers); Redis excludes it from the maxmemory check. */
  memNotCountedForEvict?: number;
  /**
   * Whether a failed BGSAVE refuses writes (stop-writes-on-bgsave-error yes
   * with save points configured). null/undefined = unknown, treated as yes.
   */
  rdbStopsWrites?: boolean | null;
  now: number;
  quietMs?: number;
}

export interface WriteRejectionEvaluation {
  /**
   * 'rejected' when the edge opens, 'escalated' when an open edge turns
   * critical or gains a cause, 'recovered' when it closes; null otherwise.
   */
  transition: 'rejected' | 'escalated' | 'recovered' | null;
  /**
   * 'critical' once clients actually received the error, 'warning' while only
   * at risk. While the edge is open this is the highest severity it reached.
   */
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
 * Causes that only clear once the server reports persistence healthy again.
 * persistence_failed is excluded: it means MISCONF arrived with no failing
 * status visible (often a host that hides INFO persistence), so the quiet
 * window is the only evidence recovery can ever get.
 */
const PERSISTENCE_CAUSES: readonly WriteRejectionCause[] = ['rdb_bgsave_failed', 'aof_write_failed'];

/**
 * Persistence gate for recovery, applied only to edges that include a
 * persistence-derived cause. Such an edge needs the server to report the
 * statuses as ok; a poll that lacks them proves nothing and keeps it open.
 * The RDB status counts only when a failed BGSAVE refuses writes, mirroring
 * the opening path (rdbStopsWrites !== false). Errorstats-only edges (OOM,
 * READONLY, NOREPLICAS, persistence_failed) don't depend on persistence, so a
 * non-blocking bgsave error or an absent persistence section can't pin them open.
 */
function persistenceClear(
  persistence: Partial<PersistenceInfo> | undefined,
  edgeCauses: readonly WriteRejectionCause[],
  rdbStopsWrites: boolean | null | undefined,
): boolean {
  if (!edgeCauses.some((cause) => PERSISTENCE_CAUSES.includes(cause))) return true;
  const rdbOk = rdbStopsWrites === false || persistence?.rdb_last_bgsave_status === 'ok';
  return rdbOk && persistence?.aof_last_write_status === 'ok';
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
 * it still sees the whole delta. Recovery needs no active cause for quietMs,
 * used_memory back below maxmemory for an OOM edge, and, only for an edge
 * with a persistence-derived cause, persistence reported healthy (RDB status
 * ignored when a failed BGSAVE doesn't stop writes) rather than merely absent.
 *
 * READONLY on a node that reports itself a replica is expected (probes,
 * misrouted clients) and never opens an edge; its counter is still
 * baselined so a later promotion doesn't fire on old counts.
 *
 * While the edge is open, it escalates once when severity first reaches
 * critical and once per cause not yet reported; staying critical, or causes
 * repeating or shrinking, stays quiet.
 */
export function evaluateWriteRejection(
  state: WriteRejectionState,
  input: WriteRejectionInput,
): WriteRejectionEvaluation {
  const { persistence, errorstats, now } = input;
  const causes = new Set<WriteRejectionCause>();
  const rejectedSinceLastPoll: Partial<Record<WriteRejectionCode, number>> = {};
  const isReplica = input.role === 'slave' || input.role === 'replica';

  if (persistence?.rdb_last_bgsave_status === 'err' && input.rdbStopsWrites !== false) {
    causes.add('rdb_bgsave_failed');
  }
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
      // Writes to a by-design replica are normal; the baseline above stays
      // current, but no outage edge opens.
      if (code === 'READONLY' && isReplica) continue;
      rejectedSinceLastPoll[code] = delta;
      if (code === 'MISCONF') {
        if (!causes.has('rdb_bgsave_failed') && !causes.has('aof_write_failed')) {
          causes.add('persistence_failed');
        }
      } else {
        causes.add(CAUSE_BY_CODE[code]);
      }
    }
  }

  const severity: WriteRejectionSeverity =
    Object.keys(rejectedSinceLastPoll).length > 0 ? 'critical' : 'warning';
  const active = causes.size > 0;
  let transition: WriteRejectionEvaluation['transition'] = null;
  if (active) state.lastActiveAt = now;

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
    const quietMs = input.quietMs ?? RECOVERY_QUIET_MS;
    const quietLongEnough = state.lastActiveAt !== null && now - state.lastActiveAt >= quietMs;
    const memoryClear =
      !state.lastCauses.includes('maxmemory_reached') ||
      input.maxMemory === undefined ||
      input.maxMemory === 0 ||
      input.usedMemory === undefined ||
      input.usedMemory - (input.memNotCountedForEvict ?? 0) < input.maxMemory;
    if (
      quietLongEnough &&
      memoryClear &&
      persistenceClear(persistence, state.lastCauses, input.rdbStopsWrites)
    ) {
      transition = 'recovered';
    }
  }

  // Report the edge's level, never the poll's: an escalation driven by a new
  // cause on a quiet poll must not downgrade an edge that already went critical.
  // A recovery closes the edge, so it reports the poll's own (warning) level.
  const reportedSeverity: WriteRejectionSeverity =
    transition !== 'recovered' &&
    state.rejecting &&
    (state.lastSeverity === 'critical' || severity === 'critical')
      ? 'critical'
      : severity;

  const rejectingForMs = state.rejectingSince === null ? null : now - state.rejectingSince;
  if (transition === 'recovered') {
    state.rejecting = false;
    state.rejectingSince = null;
    state.lastSeverity = null;
    state.lastCauses = [];
    state.lastActiveAt = null;
  }

  return {
    transition,
    severity: reportedSeverity,
    causes: [...causes],
    rejectedSinceLastPoll,
    rejectingForMs,
  };
}
