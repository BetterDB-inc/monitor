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
  /** When true, ignore sampleSize and SCAN the entire keyspace (deep scan). */
  fullScan?: boolean;
}

export interface KeySizeBucket {
  /** Human bucket label as emitted by INFO keysizes, e.g. "1", "16", "1K", "32K". */
  bucket: string;
  count: number;
}

export interface KeySizeTypeDistribution {
  /** "sizes" = byte length (strings); "items" = element count (collections). */
  metric: 'sizes' | 'items';
  buckets: KeySizeBucket[];
}

/**
 * Parsed `INFO keysizes` output: whole-keyspace size distribution maintained by the
 * server (Valkey >= 8.1 / Redis >= 7.4), with zero key scanning.
 */
export interface KeySizeDistribution {
  /** db -> data type (strings|lists|sets|zsets|hashes|streams) -> distribution. */
  databases: Record<string, Record<string, KeySizeTypeDistribution>>;
  /** False when the server does not expose the keysizes section. */
  available: boolean;
}

export interface KeyPatternData {
  pattern: string;
  count: number;
  totalMemory: number;
  maxMemory: number;
  totalCardinality: number;
  maxCardinality: number;
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
  keyDetails?: Array<{
    keyName: string;
    keyType: string | null;
    /** #elements for collections, byte length for strings (valkey #1827 "bigkey" metric) */
    cardinality: number | null;
    freqScore: number | null;
    idleSeconds: number | null;
    memoryBytes: number | null;
    ttl: number | null;
  }>;
}

/**
 * A ranked key entry. `lfu`/`idletime` rank by access recency (hot keys);
 * `cardinality` ranks by element count / byte length (largest keys, valkey #1827).
 */
export interface HotKeyEntry {
  id: string;
  keyName: string;
  connectionId: string;
  capturedAt: number;
  signalType: 'lfu' | 'idletime' | 'cardinality';
  freqScore?: number;
  idleSeconds?: number;
  memoryBytes?: number;
  /** #elements for collections, byte length for strings. Set for `cardinality` entries. */
  cardinality?: number;
  keyType?: string;
  ttl?: number;
  rank: number;
}

export interface HotKeyQueryOptions {
  connectionId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
  latest?: boolean;
  oldest?: boolean;
  /** Restrict to these signal types. Defaults to access signals (`lfu`, `idletime`). */
  signalTypes?: Array<HotKeyEntry['signalType']>;
}
