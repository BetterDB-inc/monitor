import type { HotKeyEntry } from '../types/key-analytics';

export const STALE_KEY_IDLE_SECONDS = 86400;

// Upper bound on the hot-key rows a single read fetches before global re-ranking.
// Hot keys are stored ranked 1..N PER logical database, so a read that spans
// databases must pull the whole capture and re-rank before applying the caller's
// limit — a storage-level limit would truncate by per-db rank. Generous against
// the collector's per-db top-N so a many-database instance is still fully covered.
export const HOT_KEYS_FETCH_CAP = 10_000;

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

// Collapse multi-snapshot reads to each (db, key)'s largest-memory observation,
// so a key that appears once per snapshot does not dominate the ranking.
function dedupeHotKeysByMaxMemory(entries: HotKeyEntry[]): HotKeyEntry[] {
  const byKey = new Map<string, HotKeyEntry>();
  for (const entry of entries) {
    const identity = dbScopedIdentity(entry.db, entry.keyName);
    const existing = byKey.get(identity);
    if (existing === undefined || (entry.memoryBytes ?? 0) > (existing.memoryBytes ?? 0)) {
      byKey.set(identity, entry);
    }
  }
  return Array.from(byKey.values());
}

/**
 * Re-rank a merged, possibly multi-database hot-key set by the collector's
 * hotness policy — LFU frequency descending, then idle recency ascending —
 * slice to `limit`, and renumber contiguously by position. Stored ranks are
 * per logical database, so an unfiltered read is interleaved (rank 1 of every
 * db, then rank 2, ...) and MUST be re-ranked globally before a limit is
 * applied; otherwise the limit truncates by per-db rank and drops a database's
 * genuinely hotter keys. Single definition shared by the REST/service path
 * (KeyAnalyticsService.getHotKeys) and the MCP hot-keys tool so both return the
 * same global top-N. Pass `singleSnapshot: true` for a latest/oldest read (one
 * capture, no cross-snapshot dedupe needed).
 */
export function rankHotKeys(
  entries: HotKeyEntry[],
  options: { limit?: number; singleSnapshot?: boolean } = {},
): HotKeyEntry[] {
  const { limit, singleSnapshot = false } = options;
  const candidates = singleSnapshot ? entries : dedupeHotKeysByMaxMemory(entries);
  const ranked = [...candidates].sort((a, b) => {
    const aLfu = a.freqScore !== undefined && a.freqScore !== null;
    const bLfu = b.freqScore !== undefined && b.freqScore !== null;
    if (aLfu !== bLfu) return aLfu ? -1 : 1;
    if (aLfu && bLfu) return (b.freqScore ?? 0) - (a.freqScore ?? 0);
    return (a.idleSeconds ?? 0) - (b.idleSeconds ?? 0);
  });
  const limited = limit === undefined ? ranked : ranked.slice(0, limit);
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
