import { randomUUID } from 'crypto';
import type { Logger } from '@nestjs/common';
import type { CapturedLogType, LogCaptureGap } from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { detectCaptureGap, LOG_CATCH_UP_MAX_FETCH } from './capture-gap';

export interface RecordCaptureGapInput {
  connectionId: string;
  connectionName: string;
  logType: CapturedLogType;
  /** Last id persisted before this poll (null = no baseline yet). */
  lastSeenId: number | null;
  /** Every entry read in this poll (newest first, as the server returns them). */
  entries: readonly { id: number }[];
  /** How many entries this poll asked the server for. */
  requested: number;
  previousPollAt: number | null;
  intervalMs: number;
  now: number;
}

/**
 * Detect and persist a capture gap for one poll. Never throws: losing the gap
 * record must not fail the poll, because the poll has already persisted the
 * entries it did read and must still advance its last seen id.
 */
export async function recordCaptureGap(
  storage: StoragePort,
  logger: Logger,
  input: RecordCaptureGapInput,
): Promise<LogCaptureGap | null> {
  const detected = detectCaptureGap({
    lastSeenId: input.lastSeenId,
    entries: input.entries,
    requested: input.requested,
    maxFetch: LOG_CATCH_UP_MAX_FETCH,
    now: input.now,
    previousPollAt: input.previousPollAt,
    intervalMs: input.intervalMs,
  });
  if (detected === null) return null;

  const gap: LogCaptureGap = {
    id: randomUUID(),
    connectionId: input.connectionId,
    logType: input.logType,
    firstMissingId: detected.firstMissingId,
    lastMissingId: detected.lastMissingId,
    missingCount: detected.missingCount,
    cause: detected.cause,
    capturedCount: detected.capturedCount,
    previousPollAt: input.previousPollAt,
    detectedAt: input.now,
  };

  logger.warn(
    `${input.logType} for ${input.connectionName}: ${gap.missingCount} entries (ids ${gap.firstMissingId}-${gap.lastMissingId}) were gone before they could be read (${gap.cause})`,
  );

  try {
    await storage.getLogCaptureGapRepository().insert(gap);
  } catch (error) {
    logger.warn(
      `Failed to record ${input.logType} capture gap for ${input.connectionName}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return gap;
}
