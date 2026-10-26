import type { ReplicationLagEntry } from '@betterdb/shared';
import { formatBytes } from '../../scaling-readiness/dimension-inputs';

export const CUTOVER_POLL_MS = 500;
export const CUTOVER_DEFAULT_TIMEOUT_S = 300;
export const CUTOVER_KILL_GRACE_MS = 3000;
const CUTOVER_MIN_TIMEOUT_S = 10;
const CUTOVER_MAX_TIMEOUT_S = 3600;
const STABLE_WINDOW_FLOOR_MS = 2000;
const LOG_INTERVAL_MS = 1000;

export function cutoverStableWindowMs(expectedShards: number | null): number {
  return Math.max(STABLE_WINDOW_FLOOR_MS, 2 * (expectedShards ?? 0) * LOG_INTERVAL_MS);
}

export function cutoverTimeoutNotice(expectedShards: number | null): string {
  const base =
    'Cutover timed out: writes on the source are keeping the target behind. Pause writes and retry, or force the cutover.';
  return expectedShards === null
    ? `${base} The number of source shards is unknown, so a normal cutover cannot confirm zero lag.`
    : base;
}

export function forcedCutoverNotice(
  entries: ReplicationLagEntry[] | null,
  expectedShards: number | null,
): string {
  const parts = (entries ?? []).map((entry) =>
    entry.diff === null ? `${entry.shard} initial sync` : `${entry.shard} ${formatBytes(entry.diff)} behind`,
  );
  const missing = expectedShards === null ? 0 : expectedShards - parts.length;
  if (missing > 0) {
    parts.push(`${missing} shard(s) with no report`);
  }
  return parts.length === 0 ? 'Forced cutover with no lag reports.' : `Forced cutover with ${parts.join(', ')}.`;
}

export function parseCutoverTimeout(value: unknown): number | null {
  if (value === undefined) {
    return CUTOVER_DEFAULT_TIMEOUT_S;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < CUTOVER_MIN_TIMEOUT_S ||
    value > CUTOVER_MAX_TIMEOUT_S
  ) {
    return null;
  }
  return value;
}
