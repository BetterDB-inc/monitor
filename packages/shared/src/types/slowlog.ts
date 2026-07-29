export interface SlowLogPatternExample {
  id: number;
  timestamp: number;
  duration: number;
  fullCommand: string[];
  clientAddress: string;
}

export interface PatternClientBreakdown {
  clientIdentifier: string;
  count: number;
  percentage: number;
  avgDuration: number;
  maxDuration: number;
}

export interface SlowLogPatternStats {
  pattern: string;
  command: string;
  keyPattern: string;
  count: number;
  percentage: number;
  totalDuration: number;
  avgDuration: number;
  maxDuration: number;
  minDuration: number;
  examples: SlowLogPatternExample[];
  clientBreakdown: PatternClientBreakdown[];
}

export interface CommandBreakdown {
  command: string;
  count: number;
  percentage: number;
  avgDuration: number;
}

export interface KeyPrefixBreakdown {
  prefix: string;
  count: number;
  percentage: number;
  avgDuration: number;
}

export interface ClientBreakdown {
  clientIdentifier: string;
  count: number;
  percentage: number;
  avgDuration: number;
}

export interface SlowLogPatternAnalysis {
  totalEntries: number;
  analyzedAt: number;
  patterns: SlowLogPatternStats[];
  byCommand: CommandBreakdown[];
  byKeyPrefix: KeyPrefixBreakdown[];
  byClient: ClientBreakdown[];
}

/** One key whose SCAN-family replies vastly exceed the requested COUNT (valkey#3955). */
export interface ScanSkewOffender {
  /** The scanned key, or `SCAN <pattern>` for keyless keyspace scans. */
  key: string;
  verb: string;
  sightings: number;
  worstBytesPerElement: number;
  totalBytes: number;
  lastTimestamp: number;
  message: string;
}

export interface ScanSkewReport {
  offenders: ScanSkewOffender[];
  entriesAnalyzed: number;
}
