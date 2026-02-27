export interface KeyPatternSnapshot {
  id: string;
  timestamp: number;
  pattern: string;
  keyCount: number;
  sampledKeyCount: number;
  keysWithTtl: number;
  keysExpiringSoon: number;
  totalMemoryBytes: number;
  avgMemoryBytes: number;
  maxMemoryBytes: number;
  avgAccessFrequency?: number;
  hotKeyCount?: number;
  coldKeyCount?: number;
  avgIdleTimeSeconds?: number;
  staleKeyCount?: number;
  avgTtlSeconds?: number;
  minTtlSeconds?: number;
  maxTtlSeconds?: number;
  connectionId?: string;
}

export interface KeyPatternQueryOptions {
  startTime?: number;
  endTime?: number;
  pattern?: string;
  limit?: number;
  offset?: number;
  connectionId?: string;
}

export interface KeyAnalyticsSummary {
  totalPatterns: number;
  totalKeys: number;
  totalMemoryBytes: number;
  staleKeyCount: number;
  hotKeyCount: number;
  coldKeyCount: number;
  keysExpiringSoon: number;
  byPattern: Record<
    string,
    {
      keyCount: number;
      memoryBytes: number;
      avgMemoryBytes: number;
      staleCount: number;
      hotCount: number;
      coldCount: number;
    }
  >;
  timeRange: { earliest: number; latest: number } | null;
}

export interface PatternTrend {
  timestamp: number;
  keyCount: number;
  memoryBytes: number;
  staleCount: number;
}

export interface KeyAnalyticsOptions {
  sampleSize: number;
  scanBatchSize: number;
}

export interface KeyPatternData {
  pattern: string;
  count: number;
  totalMemory: number;
  maxMemory: number;
  totalIdleTime: number;
  withTtl: number;
  withoutTtl: number;
  ttlValues: number[];
  accessFrequencies: number[];
}

export interface KeyAnalyticsResult {
  dbSize: number;
  scanned: number;
  patterns: KeyPatternData[];
}
