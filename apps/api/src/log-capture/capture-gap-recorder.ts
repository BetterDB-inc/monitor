import { randomUUID } from 'crypto';
import type { Logger } from '@nestjs/common';
import type { CapturedLogType, LogCaptureGap } from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { withTimeout } from '../common/utils/with-timeout';
import {
  detectCaptureGap,
  LOG_CAPTURE_AUX_TIMEOUT_MS,
  LOG_CATCH_UP_MAX_FETCH,
  type DetectedCaptureGap,
} from './capture-gap';

export interface RecordCaptureGapInput {
  connectionId: string;
  connectionName: string;
  logType: CapturedLogType;
  /** Last id persisted before this poll (null = no baseline yet). */
  lastSeenId: number | null;
  /** Union of every read in this poll (newest first, as the server returns them). */
  entries: readonly { id: number }[];
  /** How many entries the read that bounds the window asked the server for. */
  requested: number;
  /** How many entries that read returned. */
  received: number;
  previousPollAt: number | null;
  intervalMs: number;
  now: number;
  /**
   * Current `*-max-len` of the server, or null when unknown. Only called when
   * a gap looks like a `fetch_limit`, so normal polls make no extra round-trip.
   */
  readServerMaxLen: () => Promise<number | null>;
}

/**
 * Detect and persist capture gaps for one poll. Never throws: losing the gap
 * record must not fail the poll, because the poll has already persisted the
 * entries it did read and must still advance its last seen id.
 */
export async function recordCaptureGap(
  storage: StoragePort,
  logger: Logger,
  input: RecordCaptureGapInput,
): Promise<LogCaptureGap[]> {
  const detect = (serverMaxLen: number | null): DetectedCaptureGap[] =>
    detectCaptureGap({
      lastSeenId: input.lastSeenId,
      entries: input.entries,
      requested: input.requested,
      received: input.received,
      maxFetch: LOG_CATCH_UP_MAX_FETCH,
      now: input.now,
      previousPollAt: input.previousPollAt,
      intervalMs: input.intervalMs,
      serverMaxLen,
    });

  let detected = detect(null);
  if (detected.length === 1 && detected[0].cause === 'fetch_limit') {
    let serverMaxLen: number | null;
    try {
      serverMaxLen = await input.readServerMaxLen();
    } catch {
      serverMaxLen = null;
    }
    if (serverMaxLen !== null) detected = detect(serverMaxLen);
  }

  const gaps: LogCaptureGap[] = [];
  for (const piece of detected) {
    const gap: LogCaptureGap = {
      id: randomUUID(),
      connectionId: input.connectionId,
      logType: input.logType,
      firstMissingId: piece.firstMissingId,
      lastMissingId: piece.lastMissingId,
      missingCount: piece.missingCount,
      cause: piece.cause,
      capturedCount: piece.capturedCount,
      previousPollAt: input.previousPollAt,
      detectedAt: input.now,
    };
    gaps.push(gap);

    logger.warn(
      `${input.logType} for ${input.connectionName}: ${gap.missingCount} entries (ids ${gap.firstMissingId}-${gap.lastMissingId}) were gone before they could be read (${gap.cause})`,
    );

    try {
      // The pending query is not cancelled; we only stop waiting for it so
      // lastSeenId and the next tick still progress.
      await withTimeout(storage.getLogCaptureGapRepository().insert(gap), LOG_CAPTURE_AUX_TIMEOUT_MS);
    } catch (error) {
      logger.warn(
        `Failed to record ${input.logType} capture gap for ${input.connectionName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return gaps;
}
