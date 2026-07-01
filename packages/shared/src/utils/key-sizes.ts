import type { KeyDetail, KeySizeDistribution, KeySizeTypeDistribution } from '../types/key-analytics';

/**
 * Number of top entries retained per ranking signal. Downstream only persists
 * the top-N hot keys (LFU / idletime) and top-N largest keys (cardinality),
 * so we never need to keep more than this per metric.
 */
export const KEY_DETAILS_TOP_N = 50;

/** Prune once the working set exceeds this, to bound memory during a full scan. */
export const KEY_DETAILS_PRUNE_AT = 512;

/**
 * Bound an accumulating `keyDetails` list to the keys that can actually surface
 * downstream: the top `topN` by LFU frequency (desc), by idle time (asc), and by
 * cardinality (desc), deduplicated. A full-keyspace deep scan would otherwise
 * grow this array linearly with key count and serialize the whole thing across
 * the agent path, risking OOM / timeouts.
 */
export function pruneKeyDetails(details: KeyDetail[], topN = KEY_DETAILS_TOP_N): KeyDetail[] {
  const byFreq = details
    .filter((d) => d.freqScore !== null)
    .sort((a, b) => (b.freqScore ?? 0) - (a.freqScore ?? 0))
    .slice(0, topN);
  const byIdle = details
    .filter((d) => d.idleSeconds !== null)
    .sort((a, b) => (a.idleSeconds ?? 0) - (b.idleSeconds ?? 0))
    .slice(0, topN);
  const byCardinality = details
    .filter((d) => d.cardinality !== null)
    .sort((a, b) => (b.cardinality ?? 0) - (a.cardinality ?? 0))
    .slice(0, topN);

  const seen = new Set<string>();
  const pruned: KeyDetail[] = [];
  for (const d of [...byFreq, ...byIdle, ...byCardinality]) {
    if (!seen.has(d.keyName)) {
      seen.add(d.keyName);
      pruned.push(d);
    }
  }
  return pruned;
}

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
