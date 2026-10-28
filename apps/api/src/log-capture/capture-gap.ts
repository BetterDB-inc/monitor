import type { CaptureGapCause, CapturedLogType, LogCaptureLogSummary } from '@betterdb/shared';
import { LOG_CAPTURE_MAX_LEN_PARAMETER } from '@betterdb/shared';
import type { LogCaptureGapAggregate } from '../common/interfaces/log-capture-gap-repository.interface';

/** Entries the slowlog and commandlog pollers read on every poll (unchanged steady state). */
export const LOG_POLL_BATCH = 128;

/**
 * Upper bound for the one-off catch-up read issued when the regular batch does
 * not reach back to the last seen id. Bounds the reply size (an entry carries
 * up to 32 arguments of up to 128 bytes each) so a burst cannot turn one poll
 * into a multi-megabyte read.
 */
export const LOG_CATCH_UP_MAX_FETCH = 1024;

/** A poll this many intervals late means BetterDB itself was not watching. */
export const MONITOR_OFFLINE_INTERVAL_FACTOR = 3;

/** Bounds for a recommended `*-max-len`. */
export const MIN_RECOMMENDED_MAX_LEN = 256;
export const MAX_RECOMMENDED_MAX_LEN = 8192;

interface IdEntry {
  id: number;
}

function maxId(entries: readonly IdEntry[]): number {
  let max = -Infinity;
  for (const entry of entries) {
    if (entry.id > max) max = entry.id;
  }
  return max;
}

/**
 * Decide whether the regular batch needs a larger catch-up read.
 *
 * Returns the number of entries to request, or null when the batch already
 * covers everything new: there is no baseline yet, the server returned fewer
 * entries than asked (so it holds nothing older), nothing is new, the id
 * sequence went backwards (server restart, handled by the caller), or the
 * oldest returned entry is contiguous with the last seen id.
 */
export function planCatchUpFetch(input: {
  lastSeenId: number | null;
  batch: readonly IdEntry[];
  batchLimit: number;
  maxFetch: number;
}): number | null {
  const { lastSeenId, batch, batchLimit, maxFetch } = input;
  if (lastSeenId === null || batch.length < batchLimit) return null;
  const newest = maxId(batch);
  if (!(newest > lastSeenId)) return null;
  let oldest = Infinity;
  for (const entry of batch) {
    if (entry.id < oldest) oldest = entry.id;
  }
  if (oldest <= lastSeenId + 1) return null;
  const wanted = Math.min(newest - lastSeenId, maxFetch);
  return wanted > batch.length ? wanted : null;
}

export interface DetectedCaptureGap {
  firstMissingId: number;
  lastMissingId: number;
  missingCount: number;
  cause: CaptureGapCause;
  capturedCount: number;
}

/**
 * Classify why entries went missing. Order matters: a late poll explains any
 * loss on its own, so it wins; otherwise the loss is ours only when we asked
 * for the cap, received the cap, and still needed more.
 */
export function classifyGapCause(input: {
  previousPollAt: number | null;
  now: number;
  intervalMs: number;
  requested: number;
  received: number;
  needed: number;
  maxFetch: number;
}): CaptureGapCause {
  const { previousPollAt, now, intervalMs, requested, received, needed, maxFetch } = input;
  if (previousPollAt === null || now - previousPollAt > intervalMs * MONITOR_OFFLINE_INTERVAL_FACTOR) {
    return 'monitor_offline';
  }
  if (requested >= maxFetch && received >= maxFetch && needed > maxFetch) {
    return 'fetch_limit';
  }
  return 'server_evicted';
}

/**
 * Find the hole between the last id BetterDB persisted and the oldest new id
 * it just read. Returns null when there is no baseline, nothing new, the id
 * sequence restarted (newest <= lastSeenId), or the read is contiguous.
 */
export function detectCaptureGap(input: {
  lastSeenId: number | null;
  entries: readonly IdEntry[];
  requested: number;
  maxFetch: number;
  now: number;
  previousPollAt: number | null;
  intervalMs: number;
}): DetectedCaptureGap | null {
  const { lastSeenId, entries } = input;
  if (lastSeenId === null || entries.length === 0) return null;
  const newest = maxId(entries);
  if (!(newest > lastSeenId)) return null;

  let oldestNew = Infinity;
  let capturedCount = 0;
  for (const entry of entries) {
    if (entry.id > lastSeenId) {
      capturedCount++;
      if (entry.id < oldestNew) oldestNew = entry.id;
    }
  }

  const firstMissingId = lastSeenId + 1;
  const lastMissingId = oldestNew - 1;
  if (lastMissingId < firstMissingId) return null;

  return {
    firstMissingId,
    lastMissingId,
    missingCount: lastMissingId - firstMissingId + 1,
    capturedCount,
    cause: classifyGapCause({
      previousPollAt: input.previousPollAt,
      now: input.now,
      intervalMs: input.intervalMs,
      requested: input.requested,
      received: entries.length,
      needed: newest - lastSeenId,
      maxFetch: input.maxFetch,
    }),
  };
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

/**
 * Suggest a `*-max-len` that would have retained the largest burst that the
 * server evicted, with 2x headroom, rounded up to a power of two and clamped
 * to [MIN_RECOMMENDED_MAX_LEN, MAX_RECOMMENDED_MAX_LEN]. Only `server_evicted`
 * gaps count: raising the server setting cannot fix a BetterDB outage or the
 * per-poll read cap. Returns null when there was no evicting burst or the
 * current setting already meets the suggestion.
 */
export function recommendMaxLen(peakEvictedArrivals: number, currentMaxLen: number | null): number | null {
  if (!(peakEvictedArrivals > 0)) return null;
  const suggested = Math.min(
    MAX_RECOMMENDED_MAX_LEN,
    Math.max(MIN_RECOMMENDED_MAX_LEN, nextPowerOfTwo(peakEvictedArrivals * 2)),
  );
  if (currentMaxLen !== null && currentMaxLen >= suggested) return null;
  return suggested;
}

const CAUSES: readonly CaptureGapCause[] = ['server_evicted', 'fetch_limit', 'monitor_offline'];

/** Fold one log's per-cause aggregates into the summary shown in the UI and API. */
export function summarizeLogGaps(
  logType: CapturedLogType,
  aggregates: readonly LogCaptureGapAggregate[],
  currentMaxLen: number | null,
): LogCaptureLogSummary {
  const missingByCause: Record<CaptureGapCause, number> = {
    server_evicted: 0,
    fetch_limit: 0,
    monitor_offline: 0,
  };
  let missingEntries = 0;
  let gapCount = 0;
  let lastGapAt: number | null = null;
  let peakEvictedArrivals = 0;
  for (const aggregate of aggregates) {
    if (aggregate.logType !== logType) continue;
    missingByCause[aggregate.cause] += aggregate.missingCount;
    missingEntries += aggregate.missingCount;
    gapCount += aggregate.gapCount;
    if (lastGapAt === null || aggregate.lastGapAt > lastGapAt) lastGapAt = aggregate.lastGapAt;
    if (aggregate.cause === 'server_evicted') {
      peakEvictedArrivals = Math.max(peakEvictedArrivals, aggregate.peakArrivals);
    }
  }

  let dominantCause: CaptureGapCause | null = null;
  for (const cause of CAUSES) {
    if (missingByCause[cause] > 0 && (dominantCause === null || missingByCause[cause] > missingByCause[dominantCause])) {
      dominantCause = cause;
    }
  }

  return {
    logType,
    missingEntries,
    gapCount,
    lastGapAt,
    dominantCause,
    missingByCause,
    configParameter: LOG_CAPTURE_MAX_LEN_PARAMETER[logType],
    currentMaxLen,
    recommendedMaxLen: recommendMaxLen(peakEvictedArrivals, currentMaxLen),
  };
}
