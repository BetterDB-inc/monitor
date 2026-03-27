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
