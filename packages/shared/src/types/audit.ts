export interface StoredAclEntry {
  id: number;
  count: number;
  reason: string;
  context: string;
  object: string;
  username: string;
  ageSeconds: number;
  clientInfo: string;
  timestampCreated: number;
  timestampLastUpdated: number;
  capturedAt: number;
  sourceHost: string;
  sourcePort: number;
  connectionId?: string;
}

export interface AuditQueryOptions {
  username?: string;
  reason?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
  connectionId?: string;
}

export interface AuditStats {
  totalEntries: number;
  uniqueUsers: number;
  entriesByReason: Record<string, number>;
  entriesByUser: Record<string, number>;
  timeRange: { earliest: number; latest: number } | null;
}

