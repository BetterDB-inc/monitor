import { withTimeout } from '../common/utils/with-timeout';
import { LOG_CAPTURE_AUX_TIMEOUT_MS } from './capture-gap';

/** CONFIG GET results are cached this long per connection and parameter. */
export const MAX_LEN_CACHE_TTL_MS = 5 * 60_000;

export interface MaxLenCacheEntry {
  value: number | null;
  at: number;
}

/**
 * Current `*-max-len` of a log, or null when CONFIG is unavailable, slow,
 * unreadable or non-numeric. Failures are cached too, so a blocked CONFIG is
 * not retried on every poll. `notOlderThan` bypasses entries read before it.
 */
export async function readServerMaxLen(
  client: { getCapabilities(): { hasConfig: boolean }; getConfigValue(parameter: string): Promise<string | null> },
  parameter: string,
  cache: Map<string, MaxLenCacheEntry>,
  cacheKey: string,
  now: number,
  notOlderThan?: number,
): Promise<number | null> {
  const cached = cache.get(cacheKey);
  if (
    cached &&
    now - cached.at < MAX_LEN_CACHE_TTL_MS &&
    (notOlderThan === undefined || cached.at >= notOlderThan)
  ) {
    return cached.value;
  }

  let value: number | null = null;
  try {
    if (client.getCapabilities().hasConfig) {
      const raw = await withTimeout(client.getConfigValue(parameter), LOG_CAPTURE_AUX_TIMEOUT_MS);
      const parsed = raw === null ? NaN : Number(raw);
      value = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
  } catch {
    value = null;
  }
  cache.set(cacheKey, { value, at: now });
  return value;
}
