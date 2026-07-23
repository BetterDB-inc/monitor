/**
 * Multi-dimensional ("hot big key") ranking — valkey #4189.
 *
 * The existing key-analytics lists rank each dimension independently: `lfu` (hot
 * by access frequency), `cardinality` (big by element count / byte length), and
 * a key's memory footprint rides along. A key that is *only* hot or *only* big is
 * already covered by those lists. What none of them surface is the key that is
 * extreme on MORE THAN ONE dimension at once — a large collection that is also
 * hammered, or a hot key whose value has quietly grown huge. Those are the ones
 * that actually cause incidents (bandwidth amplification, single-shard hotspots,
 * O(N) commands on a big value under load).
 *
 * This is a pure post-processing pass over the per-key data already collected in
 * one scan (no extra key access, no new server round-trips): for each of the
 * three dimensions we take the per-dimension top-N, and a key that lands in at
 * least two of those top-N sets is a composite candidate. Candidates are ranked
 * first by how many dimensions they are extreme on, then by the sum of their
 * normalized (value / dimension-max) contributions, so ties on dimension-count
 * break toward the key that is more extreme overall.
 *
 * SDK-free and side-effect-free so it can be unit-tested directly.
 */

export type CompositeDimension = 'frequency' | 'memory' | 'cardinality';

export interface CompositeCandidate {
  keyName: string;
  keyType: string | null;
  freqScore: number | null;
  memoryBytes: number | null;
  cardinality: number | null;
  ttl: number | null;
}

export interface CompositeKeyRank {
  keyName: string;
  keyType: string | null;
  ttl: number | null;
  /** Dimensions on which the key placed in that dimension's top-N (length >= 2). */
  dimensions: CompositeDimension[];
  /** Populated only when 'frequency' is in `dimensions`, else null. */
  freqScore: number | null;
  /** Populated only when 'memory' is in `dimensions`, else null. */
  memoryBytes: number | null;
  /** Populated only when 'cardinality' is in `dimensions`, else null. */
  cardinality: number | null;
  /** Sum over qualifying dimensions of value / dimensionMax, in (0, dimensions.length]. */
  score: number;
}

const DIMENSIONS: Array<{
  dimension: CompositeDimension;
  read: (c: CompositeCandidate) => number | null;
}> = [
  { dimension: 'frequency', read: (c) => c.freqScore },
  { dimension: 'memory', read: (c) => c.memoryBytes },
  { dimension: 'cardinality', read: (c) => c.cardinality },
];

/** Minimum number of dimensions a key must be extreme on to count as composite. */
export const COMPOSITE_MIN_DIMENSIONS = 2;

/**
 * Ranks the keys that are extreme on at least `COMPOSITE_MIN_DIMENSIONS` of the
 * frequency / memory / cardinality dimensions. `perDimensionTopN` is the cutoff
 * applied to each dimension before intersecting.
 */
export function rankCompositeKeys(
  candidates: CompositeCandidate[],
  perDimensionTopN: number,
): CompositeKeyRank[] {
  if (perDimensionTopN <= 0) {
    return [];
  }

  // keyName -> (dimension -> value) for the dimensions where the key made top-N.
  const membership = new Map<string, Map<CompositeDimension, number>>();
  const dimensionMax = new Map<CompositeDimension, number>();

  for (const { dimension, read } of DIMENSIONS) {
    const withValue = candidates
      .map((candidate) => ({ candidate, value: read(candidate) }))
      .filter(
        (entry): entry is { candidate: CompositeCandidate; value: number } =>
          entry.value !== null && Number.isFinite(entry.value) && entry.value > 0,
      )
      .sort((a, b) => b.value - a.value);

    if (withValue.length === 0) {
      continue;
    }
    dimensionMax.set(dimension, withValue[0].value);

    for (const { candidate, value } of withValue.slice(0, perDimensionTopN)) {
      let dims = membership.get(candidate.keyName);
      if (!dims) {
        dims = new Map<CompositeDimension, number>();
        membership.set(candidate.keyName, dims);
      }
      // Keep the largest value if a key somehow appears twice for a dimension.
      dims.set(dimension, Math.max(value, dims.get(dimension) ?? value));
    }
  }

  const ranked: CompositeKeyRank[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (seen.has(candidate.keyName)) {
      continue;
    }
    const dims = membership.get(candidate.keyName);
    if (!dims || dims.size < COMPOSITE_MIN_DIMENSIONS) {
      continue;
    }
    seen.add(candidate.keyName);

    let score = 0;
    for (const [dimension, value] of dims) {
      const max = dimensionMax.get(dimension) ?? 0;
      score += max > 0 ? value / max : 0;
    }

    ranked.push({
      keyName: candidate.keyName,
      keyType: candidate.keyType,
      ttl: candidate.ttl,
      dimensions: [...dims.keys()],
      freqScore: dims.has('frequency') ? (dims.get('frequency') as number) : null,
      memoryBytes: dims.has('memory') ? (dims.get('memory') as number) : null,
      cardinality: dims.has('cardinality') ? (dims.get('cardinality') as number) : null,
      score,
    });
  }

  // Most dimensions first; break ties by the higher normalized composite score.
  ranked.sort((a, b) => b.dimensions.length - a.dimensions.length || b.score - a.score);
  return ranked;
}
