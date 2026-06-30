import type { KeySizeDistribution, KeySizeTypeDistribution } from '../types/key-analytics';

// Matches lines like: db0_distrib_strings_sizes:1=19,2=655,4=3918,16K=3
const LINE_RE = /^db(\d+)_distrib_([a-z]+)_(sizes|items):(.+)$/;

/**
 * Parse the raw `INFO keysizes` reply into a structured distribution.
 * Unknown / unrelated lines are ignored. `available` is false when no
 * keysizes lines are present (older server or section disabled).
 */
export function parseKeySizeDistribution(raw: string): KeySizeDistribution {
  const databases: KeySizeDistribution['databases'] = {};

  for (const rawLine of raw.split(/\r?\n/)) {
    const match = LINE_RE.exec(rawLine.trim());
    if (!match) continue;

    const [, db, type, metric, rest] = match;
    const buckets = rest
      .split(',')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return null;
        const bucket = pair.slice(0, eq);
        const count = Number(pair.slice(eq + 1));
        return bucket && Number.isFinite(count) ? { bucket, count } : null;
      })
      .filter((b): b is { bucket: string; count: number } => b !== null);

    if (buckets.length === 0) continue;

    const dbKey = `db${db}`;
    (databases[dbKey] ??= {})[type] = {
      metric: metric as KeySizeTypeDistribution['metric'],
      buckets,
    };
  }

  return { databases, available: Object.keys(databases).length > 0 };
}
