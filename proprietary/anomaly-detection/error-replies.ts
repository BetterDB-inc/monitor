import { ErrorStatsInfo } from '@app/common/types/metrics.types';

const ERRORSTAT_PREFIX = 'errorstat_';

export const ERROR_REPLIES_TOP_LIMIT = 3;
export const ERROR_REPLIES_WARNING_PER_POLL = 200;
export const ERROR_REPLIES_CRITICAL_PER_POLL = 2000;
export const ERROR_REPLIES_MIN_PER_POLL = 20;

export interface ErrorstatDelta {
  prefix: string;
  delta: number;
}

export function errorRepliesPerPoll(delta: number, elapsedMs: number, intervalMs: number): number {
  const polls = Math.max(1, Math.round(elapsedMs / intervalMs));
  return Math.round(delta / polls);
}

export function readErrorstatCounts(errorstats: ErrorStatsInfo | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (errorstats === undefined) {
    return counts;
  }
  for (const [key, value] of Object.entries(errorstats)) {
    if (key.startsWith(ERRORSTAT_PREFIX) === false || typeof value === 'string') {
      continue;
    }
    counts.set(key.slice(ERRORSTAT_PREFIX.length), value.count);
  }
  return counts;
}

export function topErrorstatDeltas(
  previous: Map<string, number> | undefined,
  current: Map<string, number>,
  limit: number = ERROR_REPLIES_TOP_LIMIT,
): ErrorstatDelta[] {
  if (previous === undefined) {
    return [];
  }
  const deltas: ErrorstatDelta[] = [];
  for (const [prefix, count] of current) {
    const delta = count - (previous.get(prefix) ?? 0);
    if (delta > 0) {
      deltas.push({ prefix, delta });
    }
  }
  deltas.sort((a, b) => {
    return b.delta - a.delta || a.prefix.localeCompare(b.prefix);
  });
  return deltas.slice(0, limit);
}

export function describeErrorstatDeltas(deltas: ErrorstatDelta[]): string | null {
  if (deltas.length === 0) {
    return null;
  }
  const parts = deltas.map((d) => {
    return `${d.prefix} +${d.delta}`;
  });
  return `top error types: ${parts.join(', ')}`;
}
