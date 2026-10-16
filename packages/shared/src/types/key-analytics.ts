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
  /** Logical database index the snapshot was collected from (defaults to 0). */
  db?: number;
}

export interface KeyPatternQueryOptions {
  startTime?: number;
  endTime?: number;
  pattern?: string;
  /**
   * With a `db` filter: the usual global row limit. Without one: the limit
   * applies PER logical database, so a pattern-heavy db0 cannot fill the page
   * and hide later databases (the result is bounded at limit x databases).
   */
  limit?: number;
  offset?: number;
  connectionId?: string;
  /** Restrict to one logical database index. */
  db?: number;
}

export interface KeyAnalyticsSummary {
  totalPatterns: number;
  totalKeys: number;
  totalMemoryBytes: number;
  staleKeyCount: number | null;
  hotKeyCount: number;
  coldKeyCount: number;
  keysExpiringSoon: number;
  byPattern: Record<
    string,
    {
      keyCount: number;
      memoryBytes: number;
      avgMemoryBytes: number;
      staleCount: number | null;
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
 * server (Redis >= 8.0; no Valkey version emits the section), with zero key scanning.
 */
export interface KeySizeDistribution {
  /** db -> data type (strings|lists|sets|zsets|hashes|streams) -> distribution. */
  databases: Record<string, Record<string, KeySizeTypeDistribution>>;
  /**
   * True when the server exposes the keysizes section. A supported server with
   * an empty keyspace reports available:true with empty `databases`; false means
   * the server does not expose the section at all (pre-8 Redis / every Valkey).
   */
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
  staleCount?: number;
  withTtl: number;
  withoutTtl: number;
  ttlValues: number[];
  accessFrequencies: number[];
}

export interface KeyDetail {
  keyName: string;
  keyType: string | null;
  /** Logical database index the key lives in (defaults to 0). */
  db?: number;
  /** #elements for collections, byte length for strings (valkey #1827 "bigkey" metric) */
  cardinality: number | null;
  freqScore: number | null;
  idleSeconds: number | null;
  memoryBytes: number | null;
  ttl: number | null;
}

export interface KeyAnalyticsResult {
  dbSize: number;
  scanned: number;
  patterns: KeyPatternData[];
  keyDetails?: KeyDetail[];
  /** Logical database index the result was collected from (defaults to 0). */
  db?: number;
}

/**
 * A ranked key entry. `lfu`/`idletime` rank by access recency (hot keys);
 * `cardinality` ranks by element count / byte length (largest keys, valkey #1827);
 * `composite` ranks keys that are extreme on BOTH hotness and cardinality at
 * once — the "hot big key" that a single-signal list misses (valkey #4189).
 * Hotness is reported as `freqScore` (LFU) or `idleSeconds` (recency fallback),
 * whichever the placement used; `cardinality` carries the big-key metric.
 * `memoryBytes` is informational context on these entries (memory is not a
 * ranking dimension — it is not globally retained by the collector).
 */
export interface HotKeyEntry {
  id: string;
  keyName: string;
  connectionId: string;
  capturedAt: number;
  signalType: 'lfu' | 'idletime' | 'cardinality' | 'composite';
  freqScore?: number;
  idleSeconds?: number;
  memoryBytes?: number;
  /** #elements for collections, byte length for strings. Set for `cardinality` entries. */
  cardinality?: number;
  keyType?: string;
  ttl?: number;
  rank: number;
  /** Logical database index the key lives in (defaults to 0). */
  db?: number;
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
  /** Restrict to one logical database index. */
  db?: number;
}
