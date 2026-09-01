export type CveProduct =
  | 'redis'
  | 'valkey'
  | 'valkey-bloom'
  | 'valkey-json'
  | 'valkey-search'
  | 'redisearch';

export type CveSourceId = 'ghsa' | 'nvd' | 'mitre' | 'kev' | 'epss';

export type CveSeverity = 'low' | 'medium' | 'high' | 'critical';

export type CveConfidence = 'exact' | 'broad' | 'unversioned';

export interface BranchRange {
  branch: string;
  vulnerableAtOrBelow: string;
  vulnerableFrom?: string;
  patchedAt?: string;
}

export interface SourceProvenance {
  source: CveSourceId;
  fields: string[];
}

export interface Advisory {
  cveId: string;
  aliases: string[];
  product: CveProduct;
  affected: BranchRange[];
  severity: CveSeverity;
  cvssScore?: number;
  cwes: string[];
  knownExploited: boolean;
  epssScore?: number;
  epssPercentile?: number;
  confidence: CveConfidence;
  sources: SourceProvenance[];
  summary: string;
  references: string[];
}

export interface LoadedModule {
  name: string;
  version: string | null;
}

export interface CveFinding {
  advisory: Advisory;
  matchedOn: 'engine' | 'module';
  matchedVersion: string;
  moduleName?: string;
  fixedIn?: string;
}

export interface ScannedNode {
  nodeId: string;
  address: string;
  role: 'master' | 'replica' | 'standalone';
  product: CveProduct;
  engineVersion: string;
  modules: LoadedModule[];
  modulesUnknown?: boolean;
  findings: CveFinding[];
  unversioned: Advisory[];
  severityCounts: CveSeverityCounts;
}

export type CveSeverityCounts = Record<CveSeverity, number>;

export type CveTopology = 'standalone' | 'cluster';

export interface NotScannedNode {
  nodeId: string;
  address: string;
  reason: string;
}

export interface CveScanResult {
  connectionId: string;
  fingerprint: string;
  datasetVersion: string;
  scannedAt: number;
  lastCheckedAt: number;
  topology: CveTopology;
  nodes: ScannedNode[];
  notScanned: NotScannedNode[];
  drift: boolean;
  distinctVersions: string[];
  partial: boolean;
  missingSources: CveSourceId[];
}

export type CveSourceState = 'ok' | 'quiet' | 'empty';

export interface CveSourceStatus {
  source: CveSourceId;
  state: CveSourceState;
  lastSuccessAt: number | null;
  lastAttemptAt: number;
  recordCount: number;
  previousRecordCount: number;
  query: string;
  message?: string;
}

export interface EnrichmentEntry {
  knownExploited?: boolean;
  epssScore?: number;
  epssPercentile?: number;
}

export interface CveSourceSnapshot {
  source: CveSourceId;
  status: CveSourceStatus;
  advisories: Advisory[];
  enrichment: Array<[string, EnrichmentEntry]>;
  lastGoodAdvisories: Advisory[];
  lastGoodEnrichment: Array<[string, EnrichmentEntry]>;
}

export interface StoredCveDataset {
  datasetVersion: string;
  refreshedAt: number;
  advisories: Advisory[];
  snapshots: CveSourceSnapshot[];
}

export interface CveDatasetStatus {
  datasetVersion: string | null;
  refreshedAt: number | null;
  advisoryCount: number;
  sources: CveSourceStatus[];
  healthy: boolean;
}
