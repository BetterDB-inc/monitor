import type { BranchRange } from '@betterdb/shared';
import { branchOf, compareVersions, matchRanges } from '../matcher/version-range';

// GHSA-jqcm-9gh4-2vgv / CVE-2026-63639, captured 2026-08-31
const CVE_2026_63639: BranchRange[] = [
  { branch: '9.1', vulnerableAtOrBelow: '9.1.0', patchedAt: '9.1.1' },
  { branch: '9.0', vulnerableAtOrBelow: '9.0.4', patchedAt: '9.0.5' },
  { branch: '8.1', vulnerableAtOrBelow: '8.1.8', patchedAt: '8.1.9' },
  { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' },
  { branch: '7.2', vulnerableAtOrBelow: '7.2.13', patchedAt: '7.2.14' },
];

const NVD_ONLY: BranchRange[] = [{ branch: '*', vulnerableAtOrBelow: '9.1.0' }];

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    expect(compareVersions('8.0.10', '8.0.9')).toBeGreaterThan(0);
    expect(compareVersions('8.0.9', '8.0.10')).toBeLessThan(0);
    expect(compareVersions('8.0.9', '8.0.9')).toBe(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('8.0', '8.0.0')).toBe(0);
    expect(compareVersions('8.1', '8.0.9')).toBeGreaterThan(0);
  });
});

describe('branchOf', () => {
  it('takes the first two segments', () => {
    expect(branchOf('8.0.9')).toBe('8.0');
    expect(branchOf('9.1.1')).toBe('9.1');
  });
});

describe('matchRanges', () => {
  it('clears a patched maintenance release', () => {
    expect(matchRanges('8.0.10', CVE_2026_63639)).toEqual({ vulnerable: false, fixedIn: '8.0.10' });
  });

  it('flags the last vulnerable release on the same branch', () => {
    expect(matchRanges('8.0.9', CVE_2026_63639)).toEqual({ vulnerable: true, fixedIn: '8.0.10' });
  });

  it('does not apply another branch range to an unlisted branch', () => {
    expect(matchRanges('6.2.14', CVE_2026_63639)).toEqual({ vulnerable: false });
  });

  it('falls back to a wildcard range when no branch matches', () => {
    expect(matchRanges('8.0.10', NVD_ONLY)).toEqual({ vulnerable: true });
  });

  it('reports not vulnerable for an empty range list', () => {
    expect(matchRanges('8.0.9', [])).toEqual({ vulnerable: false });
  });
});
