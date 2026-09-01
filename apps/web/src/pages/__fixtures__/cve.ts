import type {
  Advisory,
  CveDatasetStatus,
  CveFinding,
  CveScanResult,
  CveSourceId,
  ScannedNode,
} from '@betterdb/shared';

const HOUR_MS = 3_600_000;

export function advisory(cveId: string, overrides: Partial<Advisory> = {}): Advisory {
  return {
    cveId,
    aliases: [],
    product: 'valkey',
    affected: [{ branch: '8.0', vulnerableAtOrBelow: '8.0.9', patchedAt: '8.0.10' }],
    severity: 'high',
    cvssScore: 8.8,
    cwes: [],
    knownExploited: false,
    epssScore: 0.0076,
    epssPercentile: 0.528,
    confidence: 'exact',
    sources: [{ source: 'ghsa', fields: ['affected'] }],
    summary: `${cveId} summary`,
    references: [],
    ...overrides,
  };
}

export function finding(cveId: string, overrides: Partial<CveFinding> = {}): CveFinding {
  return {
    advisory: advisory(cveId),
    matchedOn: 'engine',
    matchedVersion: '8.0.9',
    fixedIn: '8.0.10',
    ...overrides,
  };
}

export function unversionedAdvisory(cveId: string): Advisory {
  return advisory(cveId, {
    affected: [],
    confidence: 'unversioned',
    cvssScore: undefined,
    epssScore: undefined,
    epssPercentile: undefined,
  });
}

export function node(
  nodeId: string,
  engineVersion: string,
  findings: CveFinding[],
  unversioned: Advisory[] = [],
  overrides: Partial<ScannedNode> = {},
): ScannedNode {
  return {
    nodeId,
    address: `10.0.0.${nodeId}:6379`,
    role: 'master',
    product: 'valkey',
    engineVersion,
    modules: [],
    findings,
    unversioned,
    severityCounts: { low: 0, medium: 0, high: findings.length, critical: 0 },
    ...overrides,
  };
}

export function scanResult(overrides: Partial<CveScanResult> = {}): CveScanResult {
  const nodes = overrides.nodes ?? [
    node('1', '8.0.9', [finding('CVE-2026-63639')], [unversionedAdvisory('CVE-2025-49112')]),
  ];

  return {
    connectionId: 'conn-1',
    fingerprint: 'fp-1',
    datasetVersion: 'ds-1',
    scannedAt: Date.now() - 2 * HOUR_MS,
    lastCheckedAt: Date.now() - 2 * HOUR_MS,
    topology: 'standalone',
    notScanned: [],
    drift: false,
    distinctVersions: [
      ...new Set(
        nodes.map((entry) => {
          return entry.engineVersion;
        }),
      ),
    ],
    partial: false,
    missingSources: [],
    ...overrides,
    nodes,
  };
}

const SOURCE_IDS: CveSourceId[] = ['ghsa', 'nvd', 'mitre', 'kev', 'epss'];

export const HEALTHY_DATASET: CveDatasetStatus = {
  datasetVersion: 'ds-1',
  refreshedAt: Date.now() - HOUR_MS,
  advisoryCount: 12,
  sources: SOURCE_IDS.map((source) => {
    return {
      source,
      state: 'ok' as const,
      lastSuccessAt: 1,
      lastAttemptAt: 1,
      recordCount: 12,
      previousRecordCount: 12,
      query: `${source}-query`,
    };
  }),
  healthy: true,
};
