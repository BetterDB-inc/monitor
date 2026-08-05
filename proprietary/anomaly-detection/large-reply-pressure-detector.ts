/**
 * Large-reply commandlog throughput pressure (valkey-io/valkey#2926): Valkey's
 * COMMANDLOG LARGE-REPLY facility (gated by `commandlog-reply-larger-than`)
 * logs any command whose reply exceeds the configured byte threshold. The
 * upstream issue reports a ~25% GET throughput regression when hot read
 * commands repeatedly take that logging/copy path, because reply-copy
 * avoidance stops applying once a reply is large enough to be logged. The fix
 * is still open upstream — PR #3397 only raised the default threshold, which
 * masks the regression for small replies without addressing the underlying
 * cost, and the fix's own authors have asked for threshold-crossing alerting
 * in the meantime.
 *
 * We cannot patch the engine, so this module is purely advisory: it looks at
 * the persisted/cached LARGE-REPLY commandlog entries for a connection and
 * flags any command that is BOTH large (its replies cross the configured
 * threshold) AND hot (it does so repeatedly, not as a one-off spike) — the
 * combination that indicates the large-reply path is being paid on every
 * call of a busy command, not an isolated big read.
 *
 * A single rare oversized reply (e.g. a one-off KEYS/HGETALL an operator ran
 * by hand) is NOT hot and is intentionally ignored — see LARGE_REPLY_MIN_CROSSINGS.
 */

/**
 * A command must appear at least this many times in the current LARGE-REPLY
 * commandlog window, at/above the configured threshold, before it is
 * considered "hot" rather than a rare one-off large reply.
 */
export const LARGE_REPLY_MIN_CROSSINGS = 5;

/** One LARGE-REPLY commandlog entry, adapted from the raw commandlog shape. */
export interface LargeReplyEntry {
  /** Command verb (e.g. GET, MGET, HGETALL) — args are not needed for this detector. */
  command: string;
  /** Reply size in bytes — the LARGE-REPLY log's magnitude column. */
  replyBytes: number;
  /** Unix timestamp (seconds) of the logged entry. */
  timestamp: number;
}

export interface DetectLargeReplyPressureOptions {
  /** Overrides LARGE_REPLY_MIN_CROSSINGS (tests / tuning). */
  minCrossings?: number;
}

export interface LargeReplyOffender {
  command: string;
  /** Number of entries for this command at/above thresholdBytes in the window. */
  crossings: number;
  worstBytes: number;
  avgBytes: number;
  totalBytes: number;
  lastTimestamp: number;
  message: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)}KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${Math.round(mb)}MB`;
  }
  return `${(mb / 1024).toFixed(1)}GB`;
}

interface OffenderAccumulator {
  crossings: number;
  worstBytes: number;
  totalBytes: number;
  lastTimestamp: number;
}

/**
 * Analyses LARGE-REPLY commandlog entries for commands whose replies
 * repeatedly cross `thresholdBytes` — i.e. hot commands that routinely pay
 * the large-reply logging/copy path's cost (valkey#2926). Each entry is
 * re-checked against `thresholdBytes` (not just trusted from the moment it
 * was logged): an entry logged under a since-raised threshold no longer
 * qualifies, so a stale window doesn't keep alerting after an operator
 * mitigates by raising `commandlog-reply-larger-than`.
 *
 * Returns one offender per command that crosses the threshold at least
 * `minCrossings` times, worst-first by crossing count. A negative or absent
 * threshold (commandlog-reply-larger-than disabled, or unknown) yields no
 * offenders — there is nothing meaningful to compare against.
 */
export function detectLargeReplyPressure(
  entries: LargeReplyEntry[],
  thresholdBytes: number,
  opts: DetectLargeReplyPressureOptions = {},
): LargeReplyOffender[] {
  if (thresholdBytes < 0 || entries.length === 0) {
    return [];
  }
  const minCrossings = opts.minCrossings ?? LARGE_REPLY_MIN_CROSSINGS;

  const byCommand = new Map<string, OffenderAccumulator>();
  for (const entry of entries) {
    if (entry.replyBytes < thresholdBytes) continue;

    const command = entry.command.toUpperCase();
    const acc = byCommand.get(command) ?? {
      crossings: 0,
      worstBytes: 0,
      totalBytes: 0,
      lastTimestamp: 0,
    };
    acc.crossings += 1;
    acc.worstBytes = Math.max(acc.worstBytes, entry.replyBytes);
    acc.totalBytes += entry.replyBytes;
    acc.lastTimestamp = Math.max(acc.lastTimestamp, entry.timestamp);
    byCommand.set(command, acc);
  }

  const offenders: LargeReplyOffender[] = [];
  for (const [command, acc] of byCommand) {
    if (acc.crossings < minCrossings) continue;

    const avgBytes = acc.totalBytes / acc.crossings;
    offenders.push({
      command,
      crossings: acc.crossings,
      worstBytes: acc.worstBytes,
      avgBytes,
      totalBytes: acc.totalBytes,
      lastTimestamp: acc.lastTimestamp,
      message:
        `WARNING: ${command} has produced ${acc.crossings} large replies at/above the ` +
        `commandlog-reply-larger-than threshold (${formatBytes(thresholdBytes)}; worst ` +
        `${formatBytes(acc.worstBytes)}, avg ${formatBytes(avgBytes)}) in the recent COMMANDLOG ` +
        `LARGE-REPLY window. A hot command repeatedly crossing this threshold pays the ` +
        `large-reply logging/copy path on every call — reply-copy avoidance stops applying once ` +
        `a reply is large enough to be logged, a regression observed to cost up to ~25% GET ` +
        `throughput and still unfixed upstream (valkey#2926; PR #3397 only raised the default ` +
        `threshold). Consider raising commandlog-reply-larger-than, reducing how often ${command} ` +
        `returns oversized replies (pagination/projection instead of whole-collection reads), or ` +
        `disabling the large-reply log (commandlog-reply-larger-than -1) if the visibility isn't needed.`,
    });
  }

  offenders.sort((a, b) => b.crossings - a.crossings);
  return offenders;
}

/**
 * Stable signature for a large-reply offender, used to dedupe repeat alerts
 * across polls (keyed per connection by the caller). Keyed on the command
 * alone: the offense is "this command is hot in the large-reply log", not
 * any single reply size, so a fluctuating worst/avg byte size for the same
 * command must not be treated as a new offender.
 */
export function largeReplyPressureSignature(offender: LargeReplyOffender): string {
  return offender.command;
}
