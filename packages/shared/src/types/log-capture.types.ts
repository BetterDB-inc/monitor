/**
 * Log capture integrity: BetterDB polls SLOWLOG / COMMANDLOG on an interval and
 * persists what it reads. The server keeps only the newest `*-max-len` entries,
 * so when more entries arrive between two polls than the server retains (or
 * than BetterDB reads in one poll) the oldest ones are gone before BetterDB
 * sees them. Entry ids are a per-log monotonic counter that is never reset by
 * SLOWLOG/COMMANDLOG RESET, so a hole in the id sequence is an exact count of
 * what was lost.
 */

/** One server-side log BetterDB captures. */
export type CapturedLogType =
  | 'slowlog'
  | 'commandlog-slow'
  | 'commandlog-large-request'
  | 'commandlog-large-reply';

export const CAPTURED_LOG_TYPES: readonly CapturedLogType[] = [
  'slowlog',
  'commandlog-slow',
  'commandlog-large-request',
  'commandlog-large-reply',
];

/**
 * Why entries were lost.
 * - `server_evicted`: more entries arrived in one poll interval than the server keeps (`*-max-len`).
 * - `fetch_limit`: the server still had them, but more arrived than BetterDB reads in one poll.
 * - `monitor_offline`: BetterDB was not polling (restart, outage, stalled poll), so the
 *   interval was longer than usual. Not actionable on the server.
 */
export type CaptureGapCause = 'server_evicted' | 'fetch_limit' | 'monitor_offline';

/** The CONFIG parameter that sets how many entries the server retains for each log. */
export const LOG_CAPTURE_MAX_LEN_PARAMETER: Readonly<Record<CapturedLogType, string>> = {
  slowlog: 'slowlog-max-len',
  'commandlog-slow': 'commandlog-slow-execution-max-len',
  'commandlog-large-request': 'commandlog-large-request-max-len',
  'commandlog-large-reply': 'commandlog-large-reply-max-len',
};

/** The CONFIG parameter that sets which commands get logged at all. */
export const LOG_CAPTURE_THRESHOLD_PARAMETER: Readonly<Record<CapturedLogType, string>> = {
  slowlog: 'slowlog-log-slower-than',
  'commandlog-slow': 'commandlog-execution-slower-than',
  'commandlog-large-request': 'commandlog-request-larger-than',
  'commandlog-large-reply': 'commandlog-reply-larger-than',
};

/** One detected hole in a log's id sequence. */
export interface LogCaptureGap {
  id: string;
  connectionId: string;
  logType: CapturedLogType;
  /** First id BetterDB never saw (lastSeenId + 1). */
  firstMissingId: number;
  /** Last id BetterDB never saw (oldest captured new id - 1). */
  lastMissingId: number;
  missingCount: number;
  cause: CaptureGapCause;
  /** New entries BetterDB did capture in the same poll. */
  capturedCount: number;
  /** Epoch ms of the previous successful poll of this log, or null when unknown (process restart). */
  previousPollAt: number | null;
  /** Epoch ms when the gap was detected. */
  detectedAt: number;
}

export interface LogCaptureGapQuery {
  connectionId: string;
  logType?: CapturedLogType;
  /** Inclusive lower bound on detectedAt (epoch ms). */
  since?: number;
  /** Inclusive upper bound on detectedAt (epoch ms). */
  until?: number;
  limit?: number;
}

export interface LogCaptureLogSummary {
  logType: CapturedLogType;
  missingEntries: number;
  gapCount: number;
  lastGapAt: number | null;
  /** Cause with the most missing entries in the window, or null when there were no gaps. */
  dominantCause: CaptureGapCause | null;
  missingByCause: Record<CaptureGapCause, number>;
  /** Server config parameter that controls retention for this log. */
  configParameter: string;
  /** Current value of `configParameter`, or null when CONFIG GET is unavailable. */
  currentMaxLen: number | null;
  /**
   * Suggested `configParameter` value that would have retained the peak burst
   * seen in the window, or null when no server-side change would help.
   */
  recommendedMaxLen: number | null;
}

export interface LogCaptureSummary {
  connectionId: string;
  windowMs: number;
  since: number;
  computedAt: number;
  totalMissingEntries: number;
  /** Most entries BetterDB reads from one log in one poll. */
  maxFetchPerPoll: number;
  logs: LogCaptureLogSummary[];
}
