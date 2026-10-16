import type { HotKeyEntry } from '../types/key-analytics';

export const STALE_KEY_IDLE_SECONDS = 86400;

// Upper bound on the rows a key-analytics read fetches before a global re-rank.
// Hot/largest/composite keys are stored ranked 1..N PER logical database, so a
// read that spans databases must pull the whole capture and re-rank before
// applying the caller's limit — a storage-level limit would truncate by per-db
// rank. Generous against the collector's per-db top-N so a many-database
// instance is still fully covered. Shared by the hot-keys, largest-keys,
// composite-keys, and Prometheus key-analytics read paths.
export const KEY_ANALYTICS_FETCH_CAP = 10_000;

/**
 * Identity of a key or pattern scoped to a logical database: the same name in
 * two databases is two distinct entities. `db` renders as a space-free numeric
 * string, so the single leading space unambiguously delimits it from the
 * (possibly space- or colon-containing) name. Single definition shared by the
 * API dedupe/ranking paths and the web UI so the separator never diverges.
 */
export function dbScopedIdentity(db: number | undefined, name: string): string {
  return `${db ?? 0} ${name}`;
}

/**
 * The collector's hot-key ranking policy, in one place so collection-time
 * (buildHotKeyRows) and read-time (rankHotKeys) ordering can't diverge: an entry
 * with an LFU frequency ranks above one without (idle-time only); among LFU
 * entries, higher frequency first; among idle-time entries, lower idle seconds
 * (more recently accessed) first. Accepts null or undefined for either field
 * (KeyDetail uses null, HotKeyEntry uses undefined), and treats freqScore 0 as a
 * present LFU value — not missing.
 */
export function compareHotness(
  a: { freqScore?: number | null; idleSeconds?: number | null },
  b: { freqScore?: number | null; idleSeconds?: number | null },
): number {
  const aLfu = a.freqScore !== undefined && a.freqScore !== null;
  const bLfu = b.freqScore !== undefined && b.freqScore !== null;
  if (aLfu !== bLfu) return aLfu ? -1 : 1;
  if (aLfu && bLfu) return (b.freqScore ?? 0) - (a.freqScore ?? 0);
  return (a.idleSeconds ?? 0) - (b.idleSeconds ?? 0);
}

/**
 * Re-rank a merged, possibly multi-database hot-key set by the collector's
 * hotness policy (compareHotness), slice to `limit`, and renumber contiguously
 * by position. Stored ranks are per logical database, so an unfiltered read is
 * interleaved (rank 1 of every db, then rank 2, ...) and MUST be re-ranked
 * globally before a limit is applied; otherwise the limit truncates by per-db
 * rank and drops a database's genuinely hotter keys. Single definition shared by
 * the REST/service path (KeyAnalyticsService.getHotKeys) and the MCP hot-keys
 * tool so both return the same global top-N.
 *
 * For a multi-snapshot read (not latest/oldest) a key can appear once per
 * snapshot; collapse to each (db, key)'s HOTTEST observation — the first after
 * sorting — rather than by memory, since this surface ranks by hotness, not
 * size. A `singleSnapshot` read is one capture and needs no dedupe.
 */
export function rankHotKeys(
  entries: HotKeyEntry[],
  options: { limit?: number; singleSnapshot?: boolean } = {},
): HotKeyEntry[] {
  const { limit, singleSnapshot = false } = options;
  const sorted = [...entries].sort(compareHotness);
  let ranked: HotKeyEntry[];
  if (singleSnapshot) {
    ranked = sorted;
  } else {
    const seen = new Set<string>();
    ranked = [];
    for (const entry of sorted) {
      const identity = dbScopedIdentity(entry.db, entry.keyName);
      if (seen.has(identity)) continue;
      seen.add(identity);
      ranked.push(entry);
    }
  }
  const limited = limit === undefined ? ranked : ranked.slice(0, Math.max(0, limit));
  return limited.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function extractPattern(key: string): string {
  const parts = key.split(/[:._-]/);
  const patternParts = parts.map((part) => {
    if (/^\d+$/.test(part)) return '*';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return '*';
    if (/^[0-9a-f]{24}$/i.test(part)) return '*';
    if (/^[0-9a-f]{32,}$/i.test(part)) return '*';
    return part;
  });
  return patternParts.join(':');
}
