import type { CveConfidence, CveFinding } from '@betterdb/shared';

/**
 * The confidence to show for a finding. A finding matched only through the
 * fallback NVD range carries its own 'broad' confidence, which
 * must win over the advisory's vendor-level 'exact'. Older stored findings
 * have no finding-level confidence and fall back to the advisory's.
 */
export function findingConfidence(entry: CveFinding): CveConfidence {
  return entry.confidence ?? entry.advisory.confidence;
}
