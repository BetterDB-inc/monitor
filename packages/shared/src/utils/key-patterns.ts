export const STALE_KEY_IDLE_SECONDS = 86400;

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
