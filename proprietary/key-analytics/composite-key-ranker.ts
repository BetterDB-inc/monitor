/**
 * Multi-dimensional ("hot big key") ranking — valkey #4189.
 *
 * The existing key-analytics lists rank each dimension independently: hot keys
 * (by access frequency or recency), `cardinality` (big by element count / byte
 * length), and a key's memory footprint rides along. A key that is *only* hot or
 * *only* big is already covered by those lists. What none of them surface is the
 * key that is extreme on MORE THAN ONE dimension at once — a large collection
 * that is also hammered, or a hot key whose value has quietly grown huge. Those
 * are the ones that actually cause incidents (bandwidth amplification, single-
 * shard hotspots, O(N) commands on a big value under load).
 *
 * This is a pure post-processing pass over the per-key data already collected in
 * one scan (no extra key access, no new server round-trips): for each of the
 * three dimensions we take the per-dimension top-N, and a key that lands in at
 * least two of those top-N sets is a composite candidate. Candidates are ranked
 * first by how many dimensions they are extreme on, then by the sum of their
 * normalized (value / dimension-max) contributions, so ties on dimension-count
 * break toward the key that is more extreme overall.
 *
 * Hotness is measured by LFU access frequency (`OBJECT FREQ`) when the server's
 * maxmemory-policy exposes it, and otherwise by recency (`OBJECT IDLETIME`,
 * lower idle = hotter) — mirroring the fallback the hot-keys collector already
 * uses. Without that fallback the hotness dimension would be empty on the default
 * (non-LFU) policy, collapsing "composite" to memory ∩ cardinality and missing
 * the true hot+big keys this feature exists to catch.
 *
 * SDK-free and side-effect-free so it can be unit-tested directly.
 */

export type CompositeDimension = 'hotness' | 'memory' | 'cardinality';

export interface CompositeCandidate {
  keyName: string;
  keyType: string | null;
  /** LFU access frequency (OBJECT FREQ). Null unless an LFU maxmemory-policy is set. */
  freqScore: number | null;
  /** Idle seconds (OBJECT IDLETIME). The recency fallback when freqScore is absent. */
  idleSeconds: number | null;
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
  /** Set only when the key placed in 'hotness' via LFU frequency, else null. */
  freqScore: number | null;
  /** Set only when the key placed in 'hotness' via idle recency, else null. */
  idleSeconds: number | null;
  /** Populated only when 'memory' is in `dimensions`, else null. */
  memoryBytes: number | null;
  /** Populated only when 'cardinality' is in `dimensions`, else null. */
  cardinality: number | null;
  /** Sum over qualifying dimensions of value / dimensionMax, in (0, dimensions.length]. */
  score: number;
}

function isUsable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** True when the key's hotness (below) comes from LFU frequency rather than idle recency. */
function hotnessFromFrequency(candidate: CompositeCandidate): boolean {
  return isUsable(candidate.freqScore);
}

/**
 * Hotness magnitude for ranking: LFU frequency when present, otherwise recency
 * derived from idle time (1 / (1 + idle), so a lower idle ranks hotter). Returns
 * null when neither signal is available for the key.
 */
function hotnessMagnitude(candidate: CompositeCandidate): number | null {
  if (isUsable(candidate.freqScore)) {
    return candidate.freqScore;
  }
  if (candidate.idleSeconds !== null && Number.isFinite(candidate.idleSeconds) && candidate.idleSeconds >= 0) {
    return 1 / (1 + candidate.idleSeconds);
  }
  return null;
}

const DIMENSIONS: Array<{
  dimension: CompositeDimension;
  read: (c: CompositeCandidate) => number | null;
}> = [
  { dimension: 'hotness', read: hotnessMagnitude },
  { dimension: 'memory', read: (c) => c.memoryBytes },
  { dimension: 'cardinality', read: (c) => c.cardinality },
];

/** Minimum number of dimensions a key must be extreme on to count as composite. */
export const COMPOSITE_MIN_DIMENSIONS = 2;

/**
 * Ranks the keys that are extreme on at least `COMPOSITE_MIN_DIMENSIONS` of the
 * hotness / memory / cardinality dimensions. `perDimensionTopN` is the cutoff
 * applied to each dimension before intersecting.
 */
export function rankCompositeKeys(
  candidates: CompositeCandidate[],
  perDimensionTopN: number,
): CompositeKeyRank[] {
  if (perDimensionTopN <= 0) {
    return [];
  }

  // keyName -> (dimension -> ranking value) for the dimensions where the key made top-N.
  const membership = new Map<string, Map<CompositeDimension, number>>();
  const dimensionMax = new Map<CompositeDimension, number>();

  for (const { dimension, read } of DIMENSIONS) {
    const withValue = candidates
      .map((candidate) => ({ candidate, value: read(candidate) }))
      .filter((entry): entry is { candidate: CompositeCandidate; value: number } => isUsable(entry.value))
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

    const placedHotness = dims.has('hotness');
    const hotnessIsFreq = placedHotness && hotnessFromFrequency(candidate);

    ranked.push({
      keyName: candidate.keyName,
      keyType: candidate.keyType,
      ttl: candidate.ttl,
      dimensions: [...dims.keys()],
      // Report the raw signal the hotness placement came from, not the derived magnitude.
      freqScore: hotnessIsFreq ? candidate.freqScore : null,
      idleSeconds: placedHotness && !hotnessIsFreq ? candidate.idleSeconds : null,
      memoryBytes: dims.has('memory') ? candidate.memoryBytes : null,
      cardinality: dims.has('cardinality') ? candidate.cardinality : null,
      score,
    });
  }

  // Most dimensions first; break ties by the higher normalized composite score.
  ranked.sort((a, b) => b.dimensions.length - a.dimensions.length || b.score - a.score);
  return ranked;
}
