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
