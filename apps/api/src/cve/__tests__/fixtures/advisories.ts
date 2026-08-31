import type { Advisory } from '@betterdb/shared';

export const VALKEY_BRANCH_AWARE: Advisory = {
  cveId: 'CVE-2026-63639',
  aliases: ['GHSA-jqcm-9gh4-2vgv'],
  product: 'valkey',
  affected: [
    { branch: '9.1', vulnerableAtOrBelow: '9.1.0', patchedAt: '9.1.1' },
    { branch: '9.0', vulnerableAtOrBelow: '9.0.4', patchedAt: '9.0.5' },
    { branch: '8.1', vulnerableAtOrBelow: '8.1.8', patchedAt: '8.1.9' },
    { branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' },
    { branch: '7.2', vulnerableAtOrBelow: '7.2.13', patchedAt: '7.2.14' },
  ],
  severity: 'high',
  cvssScore: 8.8,
  cwes: ['CWE-122'],
  knownExploited: false,
  epssScore: 0.01,
  epssPercentile: 0.78,
  confidence: 'exact',
  sources: [{ source: 'ghsa', fields: ['affected', 'severity'] }],
  summary: 'Heap overflow in the Valkey server',
  references: ['https://github.com/valkey-io/valkey/security/advisories/GHSA-jqcm-9gh4-2vgv'],
};

export const VALKEY_KNOWN_EXPLOITED: Advisory = {
  cveId: 'CVE-2025-49844',
  aliases: ['GHSA-9rfg-jx7v-52p6'],
  product: 'valkey',
  affected: [{ branch: '8.0', vulnerableAtOrBelow: '8.0.8', patchedAt: '8.0.9' }],
  severity: 'critical',
  cvssScore: 9.9,
  cwes: ['CWE-416'],
  knownExploited: true,
  epssScore: 0.868,
  epssPercentile: 0.997,
  confidence: 'exact',
  sources: [
    { source: 'ghsa', fields: ['affected'] },
    { source: 'kev', fields: ['knownExploited'] },
  ],
  summary: 'Use-after-free reachable from a scripted command',
  references: [],
};

// Illustrative: an NVD-only range, which is branch-agnostic and therefore `broad`.
export const VALKEY_BROAD: Advisory = {
  cveId: 'CVE-2026-21863',
  aliases: [],
  product: 'valkey',
  affected: [{ branch: '*', vulnerableAtOrBelow: '9.1.0' }],
  severity: 'medium',
  cvssScore: 6.5,
  cwes: [],
  knownExploited: false,
  epssScore: 0.0076,
  epssPercentile: 0.528,
  confidence: 'broad',
  sources: [{ source: 'nvd', fields: ['affected', 'severity'] }],
  summary: 'Denial of service via a crafted command argument',
  references: [],
};

export const UNVERSIONED: Advisory = {
  cveId: 'CVE-2025-49112',
  aliases: [],
  product: 'valkey',
  affected: [],
  severity: 'high',
  cwes: [],
  knownExploited: false,
  confidence: 'unversioned',
  sources: [{ source: 'mitre', fields: ['summary'] }],
  summary: 'Awaiting analysis; no affected version ranges published',
  references: [],
};

export const REDIS_ONLY: Advisory = {
  cveId: 'CVE-2022-0543',
  aliases: [],
  product: 'redis',
  affected: [{ branch: '*', vulnerableAtOrBelow: '9.9.9' }],
  severity: 'critical',
  cvssScore: 10,
  cwes: ['CWE-862'],
  knownExploited: true,
  epssScore: 0.9935,
  epssPercentile: 0.999,
  confidence: 'broad',
  sources: [{ source: 'nvd', fields: ['affected'] }],
  summary: 'Lua sandbox escape in a Debian-packaged Redis',
  references: [],
};

export const BLOOM_MODULE: Advisory = {
  cveId: 'CVE-2026-11111',
  aliases: ['GHSA-bloom-0000-0000'],
  product: 'valkey-bloom',
  affected: [{ branch: '1.0', vulnerableAtOrBelow: '1.0.2', patchedAt: '1.0.3' }],
  severity: 'high',
  cvssScore: 7.5,
  cwes: [],
  knownExploited: false,
  epssScore: 0.004,
  epssPercentile: 0.4,
  confidence: 'exact',
  sources: [{ source: 'ghsa', fields: ['affected'] }],
  summary: 'Out-of-bounds read in the bloom filter module',
  references: [],
};

// Illustrative pair: EPSS and CVSS disagree in rank direction, to prove the ranker
// sorts by EPSS before CVSS rather than the reverse.
export const HIGH_EPSS_LOW_CVSS: Advisory = {
  cveId: 'CVE-2026-70002',
  aliases: [],
  product: 'valkey',
  affected: [{ branch: '*', vulnerableAtOrBelow: '9.9.9' }],
  severity: 'medium',
  cvssScore: 4.0,
  cwes: [],
  knownExploited: false,
  epssScore: 0.05,
  epssPercentile: 0.6,
  confidence: 'broad',
  sources: [{ source: 'nvd', fields: ['affected', 'severity'] }],
  summary: 'Illustrative: lower CVSS but higher EPSS than CVE-2026-70001',
  references: [],
};

export const LOW_EPSS_HIGH_CVSS: Advisory = {
  cveId: 'CVE-2026-70001',
  aliases: [],
  product: 'valkey',
  affected: [{ branch: '*', vulnerableAtOrBelow: '9.9.9' }],
  severity: 'high',
  cvssScore: 9.0,
  cwes: [],
  knownExploited: false,
  epssScore: 0.002,
  epssPercentile: 0.2,
  confidence: 'broad',
  sources: [{ source: 'nvd', fields: ['affected', 'severity'] }],
  summary: 'Illustrative: higher CVSS but lower EPSS than CVE-2026-70002',
  references: [],
};

export const ALL_ADVISORIES: Advisory[] = [
  VALKEY_BRANCH_AWARE,
  VALKEY_KNOWN_EXPLOITED,
  VALKEY_BROAD,
  UNVERSIONED,
  REDIS_ONLY,
  BLOOM_MODULE,
];
