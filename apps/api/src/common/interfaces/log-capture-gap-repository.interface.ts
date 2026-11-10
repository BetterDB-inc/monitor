import type { CaptureGapCause, CapturedLogType, LogCaptureGap, LogCaptureGapQuery } from '@betterdb/shared';

/** Upper bound on rows a single list() returns, whatever the caller asks for. */
export const LOG_CAPTURE_GAP_LIST_MAX = 1_000;

/** Gaps folded per log and cause, so a summary never has to page through rows. */
export interface LogCaptureGapAggregate {
  logType: CapturedLogType;
  cause: CaptureGapCause;
  gapCount: number;
  missingCount: number;
  /** Largest missing + captured in a single gap: the biggest burst seen between two polls. */
  peakArrivals: number;
  lastGapAt: number;
}

export interface LogCaptureGapRepository {
  insert(gap: LogCaptureGap): Promise<void>;
  /** Newest first by detectedAt, id descending as the tie-breaker. */
  list(query: LogCaptureGapQuery): Promise<LogCaptureGap[]>;
  /** One row per (logType, cause) with gaps detected at or after `since`. */
  summarize(connectionId: string, since: number): Promise<LogCaptureGapAggregate[]>;
  /** Deletes gaps detected before `olderThan` (epoch ms), optionally for one connection. */
  prune(olderThan: number, connectionId?: string): Promise<number>;
}

export function clampGapListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return LOG_CAPTURE_GAP_LIST_MAX;
  }
  return Math.min(Math.floor(limit), LOG_CAPTURE_GAP_LIST_MAX);
}
