import { describe, expect, it } from 'vitest';
import type { Advisory, CveFinding } from '@betterdb/shared';
import { findingConfidence } from './finding-confidence';

const advisory: Advisory = {
  cveId: 'CVE-2025-49844',
  aliases: [],
  product: 'redis',
  affected: [],
  severity: 'critical',
  cwes: [],
  knownExploited: false,
  confidence: 'exact',
  sources: [{ source: 'ghsa', fields: ['affected'] }],
  summary: 's',
  references: [],
};

function finding(extra: Partial<CveFinding> = {}): CveFinding {
  return { advisory, matchedOn: 'engine', matchedVersion: '7.0.15', ...extra };
}

describe('findingConfidence', () => {
  it('shows broad for a finding matched only through an inferred range', () => {
    expect(findingConfidence(finding({ confidence: 'broad' }))).toBe('broad');
  });

  it("falls back to the advisory's confidence for findings stored before the field existed", () => {
    expect(findingConfidence(finding())).toBe('exact');
  });
});
