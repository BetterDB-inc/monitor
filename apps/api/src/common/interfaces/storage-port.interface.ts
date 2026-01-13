export type { StoredAclEntry, AuditQueryOptions, AuditStats } from '@betterdb/shared';
export type {
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  CommandDistributionParams,
  CommandDistributionResponse,
  IdleConnectionsParams,
  IdleConnectionsResponse,
  BufferAnomaliesParams,
  BufferAnomaliesResponse,
  ActivityTimelineParams,
  ActivityTimelineResponse,
  SpikeDetectionParams,
  SpikeDetectionResponse,
} from '@betterdb/shared';
import type { StoredAclEntry, AuditQueryOptions, AuditStats } from '@betterdb/shared';
import type {
  StoredClientSnapshot,
  ClientSnapshotQueryOptions,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  CommandDistributionParams,
  CommandDistributionResponse,
  IdleConnectionsParams,
  IdleConnectionsResponse,
  BufferAnomaliesParams,
  BufferAnomaliesResponse,
  ActivityTimelineParams,
  ActivityTimelineResponse,
  SpikeDetectionParams,
  SpikeDetectionResponse,
} from '@betterdb/shared';

export interface StoragePort {
  initialize(): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;

  saveAclEntries(entries: StoredAclEntry[]): Promise<number>;
  getAclEntries(options?: AuditQueryOptions): Promise<StoredAclEntry[]>;
  getAuditStats(startTime?: number, endTime?: number): Promise<AuditStats>;
  pruneOldEntries(olderThanTimestamp: number): Promise<number>;

  saveClientSnapshot(clients: StoredClientSnapshot[]): Promise<number>;
  getClientSnapshots(options?: ClientSnapshotQueryOptions): Promise<StoredClientSnapshot[]>;
  getClientTimeSeries(startTime: number, endTime: number, bucketSizeMs?: number): Promise<ClientTimeSeriesPoint[]>;
  getClientAnalyticsStats(startTime?: number, endTime?: number): Promise<ClientAnalyticsStats>;
  getClientConnectionHistory(identifier: { name?: string; user?: string; addr?: string }, startTime?: number, endTime?: number): Promise<StoredClientSnapshot[]>;
  pruneOldClientSnapshots(olderThanTimestamp: number): Promise<number>;
}
