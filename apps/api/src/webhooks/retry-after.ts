/** Never wait longer than this for one 429. */
export const RATE_LIMIT_MAX_DELAY_MS = 10 * 60_000;
/** Give up on a rate-limited delivery after this long in total. */
export const RATE_LIMIT_MAX_WINDOW_MS = 60 * 60_000;

/** Retry-After as delay ms: delta-seconds or HTTP-date. Undefined if absent/invalid. Capped. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  let ms: number | undefined;
  if (/^\d+$/.test(trimmed)) ms = Number(trimmed) * 1000;
  else {
    const at = Date.parse(trimmed);
    if (!Number.isNaN(at)) ms = Math.max(0, at - now);
  }
  if (ms === undefined) return undefined;
  return Math.min(ms, RATE_LIMIT_MAX_DELAY_MS);
}
