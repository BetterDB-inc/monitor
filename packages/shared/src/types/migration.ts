export type MigrationJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type IncompatibilitySeverity = 'blocking' | 'warning' | 'info';

export interface Incompatibility {
  severity: IncompatibilitySeverity;
  category: string;
  title: string;
  detail: string;
}

export interface MigrationAnalysisRequest {
  sourceConnectionId: string;
  targetConnectionId: string;
  scanSampleSize?: number; // default 10000, range 1000-50000
}

export interface DataTypeCount {
  count: number;
  sampledMemoryBytes: number;
  estimatedTotalMemoryBytes: number;
}

export interface DataTypeBreakdown {
  string: DataTypeCount;
  hash: DataTypeCount;
  list: DataTypeCount;
  set: DataTypeCount;
  zset: DataTypeCount;
  stream: DataTypeCount;
  other: DataTypeCount;
}

export interface TtlDistribution {
  noExpiry: number;
  expiresWithin1h: number;
  expiresWithin24h: number;
  expiresWithin7d: number;
  expiresAfter7d: number;
  sampledKeyCount: number;
}

export interface CommandAnalysis {
  sourceUsed: 'commandlog' | 'slowlog' | 'unavailable';
  topCommands: Array<{ command: string; count: number }>;
}

export interface MigrationAnalysisResult {
  id: string;
  status: MigrationJobStatus;
  progress: number;           // 0-100
  createdAt: number;
  completedAt?: number;
  error?: string;

  // Source metadata
  sourceConnectionId?: string;
  sourceConnectionName?: string;
  sourceDbType?: 'valkey' | 'redis';
  sourceDbVersion?: string;
  isCluster?: boolean;
  clusterMasterCount?: number;

  // Target metadata
  targetConnectionId?: string;
  targetConnectionName?: string;
  targetDbType?: 'valkey' | 'redis';
  targetDbVersion?: string;
  targetIsCluster?: boolean;

  // Key / memory overview
  totalKeys?: number;
  sampledKeys?: number;
  sampledPerNode?: number;   // scanSampleSize used
  totalMemoryBytes?: number;
  estimatedTotalMemoryBytes?: number;

  // Section results
  dataTypeBreakdown?: DataTypeBreakdown;
  hfeDetected?: boolean;
  hfeKeyCount?: number;       // estimated from sample ratio
  hfeSupported?: boolean;     // false on Redis
  hfeOversizedHashesSkipped?: number;
  ttlDistribution?: TtlDistribution;
  commandAnalysis?: CommandAnalysis;

  // Compatibility
  incompatibilities?: Incompatibility[];
  blockingCount?: number;
  warningCount?: number;
}

export interface StartAnalysisResponse {
  id: string;
  status: 'pending';
}

// ── Phase 2: Execution types ──

export type ExecutionJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionMode = 'redis_shake' | 'command';

export interface MigrationExecutionRequest {
  sourceConnectionId: string;
  targetConnectionId: string;
  mode?: ExecutionMode; // default 'redis_shake'
}

export interface MigrationExecutionResult {
  id: string;
  status: ExecutionJobStatus;
  mode: ExecutionMode;
  startedAt: number;
  completedAt?: number;
  error?: string;
  keysTransferred?: number;
  bytesTransferred?: number;
  keysSkipped?: number;
  totalKeys?: number;
  // Rolling log buffer — last 500 lines.
  logs: string[];
  // Parsed progress 0–100, best-effort. null if unparseable.
  progress: number | null;
}

export interface StartExecutionResponse {
  id: string;
  status: 'pending';
}

// ── Phase 3: Validation types ──

export type ValidationJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed';

export interface KeyCountComparison {
  sourceKeys: number;
  targetKeys: number;
  discrepancy: number;          // targetKeys - sourceKeys (negative = data loss)
  discrepancyPercent: number;   // abs(discrepancy / sourceKeys) * 100
  warning?: string;             // e.g. multi-db source vs cluster target
  // Per-type estimates from Phase 1 analysis, null if analysis unavailable
  typeBreakdown?: Array<{
    type: string;
    sourceEstimate: number;
    targetEstimate: number;
  }>;
}

export type SampleKeyStatus = 'match' | 'missing' | 'type_mismatch' | 'value_mismatch';

export interface SampleKeyResult {
  key: string;
  type: string;
  status: SampleKeyStatus;
  detail?: string; // human-readable explanation for non-match
}

export interface SampleValidationResult {
  sampledKeys: number;
  matched: number;
  missing: number;
  typeMismatches: number;
  valueMismatches: number;
  // Only the non-matching keys, capped at 50 entries
  issues: SampleKeyResult[];
}

export type BaselineMetricStatus = 'normal' | 'elevated' | 'degraded' | 'unavailable';

export interface BaselineMetric {
  name: string;
  sourceBaseline: number | null;  // avg from pre-migration snapshots, null if unavailable
  targetCurrent: number | null;
  percentDelta: number | null;    // ((target - source) / source) * 100, null if unavailable
  status: BaselineMetricStatus;   // 'unavailable' if sourceBaseline is null
}

export interface BaselineComparison {
  available: boolean;
  unavailableReason?: string;   // set when available is false
  snapshotCount: number;        // how many source snapshots were used
  baselineWindowMs: number;     // time window used (e.g. last 24h before migration)
  metrics: BaselineMetric[];    // opsPerSec, usedMemory, memFragmentationRatio, cpuSys
}

export interface MigrationValidationRequest {
  sourceConnectionId: string;
  targetConnectionId: string;
  // Optional: link to the analysis that produced the source type breakdown
  analysisId?: string;
  // Optional: timestamp when migration started, used to bound the baseline window
  migrationStartedAt?: number;
}

export interface MigrationValidationResult {
  id: string;
  status: ValidationJobStatus;
  progress: number;             // 0–100
  createdAt: number;
  completedAt?: number;
  error?: string;

  sourceConnectionId?: string;
  targetConnectionId?: string;

  keyCount?: KeyCountComparison;
  sampleValidation?: SampleValidationResult;
  baseline?: BaselineComparison;

  // Overall health signal
  issueCount?: number;          // total: missing + type/value mismatches + baseline flags
  passed?: boolean;             // true if issueCount === 0 and no blocking discrepancies
}

export interface StartValidationResponse {
  id: string;
  status: 'pending';
}
