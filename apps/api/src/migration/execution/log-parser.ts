import type { SyncStage } from '@betterdb/shared';

export interface ParsedLogLine {
  keysTransferred: number | null;
  bytesTransferred: number | null;
  progress: number | null; // 0–100
  /** Stage signal from sync_reader logs. null if the line carries no stage signal. */
  syncStage: SyncStage | null;
}

const NULL_RESULT: ParsedLogLine = {
  keysTransferred: null,
  bytesTransferred: null,
  progress: null,
  syncStage: null,
};

/**
 * Best-effort detection of which stage of sync_reader a log line indicates.
 *
 * RedisShake sync_reader log lines that signal stage transitions include
 * phrases like:
 *   - "start full sync" / "send rdb to writer" → rdb_syncing
 *   - "rdb send finished" / "rdb sync done" / "full sync done" → aof_replicating
 *   - "incr sync" / "receive offset" / "send incr" → aof_replicating
 *   - "connect to" / "psync" handshake → connecting
 *
 * Patterns are intentionally permissive — the exact phrasing varies across
 * RedisShake versions. Returns null when the line is not a stage signal.
 *
 * TODO: Validate these patterns against real RedisShake output during
 * integration testing and tighten anchors as needed.
 */
function detectSyncStage(line: string): SyncStage | null {
  const lower = line.toLowerCase();

  // Order matters: aof_replicating signals override earlier rdb_syncing signals
  // because they imply RDB is already done.
  if (
    lower.includes('rdb send finished') ||
    lower.includes('rdb sync done') ||
    lower.includes('rdb sync finished') ||
    lower.includes('full sync done') ||
    lower.includes('full sync finished') ||
    lower.includes('incr sync') ||
    lower.includes('send incr') ||
    lower.includes('syncing aof') ||   // periodic stats line: "src-N, syncing aof, diff=[N]"
    /receive\s+offset[=: ]/i.test(line) ||
    /master[_\s]offset[=: ]/i.test(line)
  ) {
    return 'aof_replicating';
  }

  if (
    lower.includes('start full sync') ||
    lower.includes('send rdb') ||
    lower.includes('receiving rdb') ||
    lower.includes('rdb receiving') ||
    lower.includes('start syncing')
  ) {
    return 'rdb_syncing';
  }

  if (
    lower.includes('connect to ') ||
    lower.includes('psync') ||
    lower.includes('connecting to source')
  ) {
    return 'connecting';
  }

  return null;
}

export function parseLogLine(line: string): ParsedLogLine {
  const syncStage = detectSyncStage(line);

  // Strategy 1: Try JSON parse
  try {
    const obj = JSON.parse(line);
    if (typeof obj === 'object' && obj !== null) {
      const scanned =
        obj?.counts?.scanned ??
        obj?.key_counts?.scanned ??
        obj?.scanned ??
        null;
      const total =
        obj?.counts?.total ??
        obj?.key_counts?.total ??
        obj?.total ??
        null;
      const bytes =
        obj?.bytes ??
        obj?.bytes_transferred ??
        null;

      const keysTransferred = typeof scanned === 'number' ? scanned : null;
      const bytesTransferred = typeof bytes === 'number' ? bytes : null;
      let progress: number | null = null;

      if (typeof scanned === 'number' && typeof total === 'number' && total > 0) {
        progress = Math.min(100, Math.round((scanned / total) * 100));
      }

      if (
        keysTransferred !== null ||
        bytesTransferred !== null ||
        progress !== null ||
        syncStage !== null
      ) {
        return { keysTransferred, bytesTransferred, progress, syncStage };
      }
    }
  } catch {
    // Not JSON — fall through to regex
  }

  // Strategy 2: Regex patterns
  const result: ParsedLogLine = {
    keysTransferred: null,
    bytesTransferred: null,
    progress: null,
    syncStage,
  };

  // sync_reader periodic stat: "write_count=[26000], write_ops=[5199.92], src-N, syncing aof, diff=[0]"
  // write_count is the cumulative number of entries written to the target — use as keysTransferred.
  const writeCountMatch = line.match(/write_count=\[(\d+)\]/);
  if (writeCountMatch) {
    result.keysTransferred = parseInt(writeCountMatch[1], 10);
  }

  const scannedMatch = line.match(/scanned[=: ]+(\d+)/i);
  if (scannedMatch && result.keysTransferred === null) {
    result.keysTransferred = parseInt(scannedMatch[1], 10);
  }

  const totalMatch = line.match(/total[=: ]+(\d+)/i);
  if (totalMatch && result.keysTransferred !== null) {
    const total = parseInt(totalMatch[1], 10);
    if (total > 0) {
      result.progress = Math.min(100, Math.round((result.keysTransferred / total) * 100));
    }
  }

  const percentMatch = line.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percentMatch && result.progress === null) {
    result.progress = Math.min(100, Math.round(parseFloat(percentMatch[1])));
  }

  if (
    result.keysTransferred !== null ||
    result.bytesTransferred !== null ||
    result.progress !== null ||
    result.syncStage !== null
  ) {
    return result;
  }

  return NULL_RESULT;
}
