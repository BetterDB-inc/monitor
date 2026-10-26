import type { ReplicationLagEntry } from '@betterdb/shared';
import { formatBytes } from '../../scaling-readiness/dimension-inputs';

export const CUTOVER_POLL_MS = 500;
export const CUTOVER_DEFAULT_TIMEOUT_S = 300;
export const CUTOVER_KILL_GRACE_MS = 3000;
export const CUTOVER_DRAIN_LIMIT_MS = 60_000;
export const CUTOVER_STABLE_MS = 2000;
const CUTOVER_MIN_TIMEOUT_S = 10;
const CUTOVER_MAX_TIMEOUT_S = 3600;
export const CUTOVER_TIMEOUT_NOTICE =
  'Cutover timed out: RedisShake did not stay fully synced. Make sure writes on the source are paused, then retry or force the cutover.';

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
