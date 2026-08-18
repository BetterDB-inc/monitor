import type { SyncStage, ExecutionFailureCode } from '@betterdb/shared';

// RedisShake colourises its output: the level token arrives as e.g.
// `\x1b[1m\x1b[31mERR\x1b[0m`. Left in place, those codes wreck both the log
// viewer (a plain <div>, so they render as garbage) and any matching — a `\bERR\b`
// probe fails because the `m` from `[31m` sits right before `E`. Strip all CSI
// sequences before storing, parsing, or classifying a line.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI_CSI, '');
}

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

export type RedisShakeFailureCode = ExecutionFailureCode;

export interface RedisShakeFailure {
  code: RedisShakeFailureCode;
  /** Human-readable, actionable explanation for the UI. */
  message: string;
}

/**
 * The line that actually aborted the run. We classify off this line rather than the
 * whole buffer so we key remediation off the real cause, not incidental noise.
 *
 * RedisShake v4.6.x aborts via `log.Panicf`, which — despite the name — does NOT
 * raise a Go panic. It emits a single zerolog `Error()` line (ConsoleWriter level
 * token `ERR`) with the message plus its own call frames appended as
 * `…/foo.go:NN -> func()`, then calls `os.Exit(1)`. So the fatal line is an `ERR`
 * line, and it's the last real output. `ERR` is therefore the primary marker;
 * `panic:` / `[PANIC]` / `FATAL` are kept as defensive fallbacks for a genuine Go
 * runtime panic or a differently-configured logger.
 */
function findFatalLine(logs: string[]): string | null {
  // Drop the call frames Panicf appends and a real panic's stack — both Go source
  // (".go:168 -> processReply()") and the assembly tail ("runtime/asm_amd64.s:1650
  // -> goexit()"). They aren't the cause, and dropping them keeps the fallback from
  // returning a bare frame.
  const candidates = logs
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/\.(go|s):\d+/.test(line));
  if (candidates.length === 0) {
    return null;
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (/\bERR\b|panic:|\[PANIC\]|\bFATAL\b/i.test(candidates[i])) {
      return candidates[i];
    }
  }
  return candidates[candidates.length - 1];
}

/**
 * Classify a non-zero RedisShake exit into an actionable failure, keyed off the
 * fatal line (see `findFatalLine`) rather than the whole buffer. Returns a
 * structured `{ code }` alongside the message so the web layer can key its own
 * remediation copy off the code instead of matching on prose or a hard-coded
 * control label.
 */
export function classifyRedisShakeFailure(exitCode: number | null, logs: string[]): RedisShakeFailure {
  const fatalLine = findFatalLine(logs);
  const codeSuffix = exitCode === null ? 'unknown' : String(exitCode);

  if (fatalLine !== null && /BUSYKEY/i.test(fatalLine)) {
    return {
      code: 'BUSYKEY',
      message:
        'Migration failed: the target already contains one or more of the keys being ' +
        'migrated (BUSYKEY). RedisShake will not overwrite existing keys. Enable the option ' +
        'to flush the target before migration, or point the migration at an empty target, ' +
        `then run it again. (exit code ${codeSuffix})`,
    };
  }

  return { code: 'UNKNOWN', message: `RedisShake exited with code ${codeSuffix}` };
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
