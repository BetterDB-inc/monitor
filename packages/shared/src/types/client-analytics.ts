export interface StoredClientSnapshot {
  id: number;
  clientId: string;
  addr: string;
  name: string;
  user: string;
  db: number;
  cmd: string;
  age: number;
  idle: number;
  flags: string;
  sub: number;
  psub: number;
  qbuf: number;
  qbufFree: number;
  obl: number;
  oll: number;
  omem: number;
  capturedAt: number;
  sourceHost: string;
  sourcePort: number;
}

export interface ClientSnapshotQueryOptions {
  clientName?: string;
  user?: string;
  addr?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export interface ClientTimeSeriesPoint {
  timestamp: number;
  totalConnections: number;
  byName: Record<string, number>;
  byUser: Record<string, number>;
  byAddr: Record<string, number>;
}

export interface ClientAnalyticsStats {
  currentConnections: number;
  peakConnections: number;
  peakTimestamp: number;
  uniqueClientNames: number;
  uniqueUsers: number;
  uniqueIps: number;
  connectionsByName: Record<string, { current: number; peak: number; avgAge: number }>;
  connectionsByUser: Record<string, { current: number; peak: number }>;
  connectionsByUserAndName: Record<string, { user: string; name: string; current: number; peak: number; avgAge: number }>;
  timeRange: { earliest: number; latest: number } | null;
}

// Advanced Analytics Interfaces

export interface CommandDistributionParams {
  startTime?: number;  // Unix ms, default: 1 hour ago
  endTime?: number;    // Unix ms, default: now
  groupBy?: 'client_name' | 'user' | 'addr';  // default: client_name
}

export interface CommandDistributionResponse {
  timeRange: { start: number; end: number };
  totalSnapshots: number;
  distribution: Array<{
    identifier: string;        // client name, user, or addr
    commands: Record<string, number>;  // { GET: 1500, SET: 300, HGET: 200 }
    totalCommands: number;
    topCommand: string;
    activityPercentage: number;  // % of total snapshots this client appeared in
  }>;
}

export interface IdleConnectionsParams {
  idleThresholdSeconds?: number;  // default: 300 (5 min)
  minOccurrences?: number;        // default: 10 (seen idle in 10+ snapshots)
}

export interface IdleConnectionsResponse {
  threshold: number;
  connections: Array<{
    identifier: string;
    addr: string;
    user: string;
    avgIdleSeconds: number;
    maxIdleSeconds: number;
    occurrences: number;
    firstSeen: number;
    lastSeen: number;
    recommendation: string;  // e.g., "Consider connection pooling" or "Possible zombie connection"
  }>;
  summary: {
    totalIdleConnections: number;
    potentialWastedResources: string;  // e.g., "12 connections idle >5 min"
  };
}

export interface BufferAnomaliesParams {
  startTime?: number;
  endTime?: number;
  qbufThreshold?: number;   // default: 1MB
  omemThreshold?: number;   // default: 10MB
}

export interface BufferAnomaliesResponse {
  anomalies: Array<{
    identifier: string;
    addr: string;
    timestamp: number;
    qbuf: number;
    qbufFree: number;
    obl: number;
    oll: number;
    omem: number;
    lastCommand: string;
    severity: 'warning' | 'critical';
    recommendation: string;
  }>;
  stats: {
    avgQbuf: number;
    maxQbuf: number;
    avgOmem: number;
    maxOmem: number;
    p95Qbuf: number;
    p95Omem: number;
  };
}

export interface ActivityTimelineParams {
  startTime?: number;
  endTime?: number;
  bucketSizeMinutes?: number;  // default: 5
  client?: string;             // optional filter by client name
}

export interface ActivityTimelineResponse {
  buckets: Array<{
    timestamp: number;
    uniqueClients: number;
    totalConnections: number;
    commandBreakdown: Record<string, number>;
    avgIdleSeconds: number;
    maxQbuf: number;
    maxOmem: number;
  }>;
}

export interface SpikeDetectionParams {
  startTime?: number;
  endTime?: number;
  sensitivityMultiplier?: number;  // default: 2 (2x standard deviation)
}

export interface SpikeDetectionResponse {
  spikes: Array<{
    timestamp: number;
    metric: 'connections' | 'commands' | 'buffer';
    value: number;
    baseline: number;
    deviation: number;
    contributingClients: Array<{
      identifier: string;
      contribution: number;  // % of spike attributable to this client
    }>;
  }>;
  baselineStats: {
    avgConnections: number;
    stdDevConnections: number;
    avgCommandsPerMinute: number;
  };
}
