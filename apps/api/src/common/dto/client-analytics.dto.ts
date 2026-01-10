import { ApiProperty } from '@nestjs/swagger';
import type {
  StoredClientSnapshot,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
} from '@betterdb/shared';

/**
 * DTO for StoredClientSnapshot - mirrors the shared interface for Swagger documentation
 */
export class StoredClientSnapshotDto implements StoredClientSnapshot {
  @ApiProperty({ description: 'Snapshot ID', example: 1 })
  id: number;

  @ApiProperty({ description: 'Client ID from Valkey/Redis', example: '123' })
  clientId: string;

  @ApiProperty({ description: 'Client address', example: '127.0.0.1:54321' })
  addr: string;

  @ApiProperty({ description: 'Client name', example: 'app-server-1' })
  name: string;

  @ApiProperty({ description: 'Authenticated username', example: 'default' })
  user: string;

  @ApiProperty({ description: 'Database number', example: 0 })
  db: number;

  @ApiProperty({ description: 'Last command executed', example: 'GET' })
  cmd: string;

  @ApiProperty({ description: 'Client age in seconds', example: 3600 })
  age: number;

  @ApiProperty({ description: 'Idle time in seconds', example: 10 })
  idle: number;

  @ApiProperty({ description: 'Client flags', example: 'N' })
  flags: string;

  @ApiProperty({ description: 'Number of channel subscriptions', example: 0 })
  sub: number;

  @ApiProperty({ description: 'Number of pattern subscriptions', example: 0 })
  psub: number;

  @ApiProperty({ description: 'Query buffer length', example: 0 })
  qbuf: number;

  @ApiProperty({ description: 'Query buffer free space', example: 32768 })
  qbufFree: number;

  @ApiProperty({ description: 'Output buffer length', example: 0 })
  obl: number;

  @ApiProperty({ description: 'Output list length', example: 0 })
  oll: number;

  @ApiProperty({ description: 'Output memory usage', example: 0 })
  omem: number;

  @ApiProperty({ description: 'Unix timestamp when captured (milliseconds)', example: 1704934800000 })
  capturedAt: number;

  @ApiProperty({ description: 'Source host where snapshot was taken', example: 'localhost' })
  sourceHost: string;

  @ApiProperty({ description: 'Source port where snapshot was taken', example: 6379 })
  sourcePort: number;
}

/**
 * DTO for ClientTimeSeriesPoint - mirrors the shared interface for Swagger documentation
 */
export class ClientTimeSeriesPointDto implements ClientTimeSeriesPoint {
  @ApiProperty({ description: 'Bucket timestamp (milliseconds)', example: 1704934800000 })
  timestamp: number;

  @ApiProperty({ description: 'Total connections in bucket', example: 15 })
  totalConnections: number;

  @ApiProperty({ description: 'Connections by client name', example: { 'app-1': 5, 'app-2': 10 } })
  byName: Record<string, number>;

  @ApiProperty({ description: 'Connections by user', example: { default: 10, admin: 5 } })
  byUser: Record<string, number>;

  @ApiProperty({ description: 'Connections by address', example: { '127.0.0.1': 15 } })
  byAddr: Record<string, number>;
}

/**
 * DTO for ClientAnalyticsStats - mirrors the shared interface for Swagger documentation
 */
export class ClientAnalyticsStatsDto implements ClientAnalyticsStats {
  @ApiProperty({ description: 'Current number of connections', example: 25 })
  currentConnections: number;

  @ApiProperty({ description: 'Peak concurrent connections', example: 150 })
  peakConnections: number;

  @ApiProperty({ description: 'Timestamp of peak connections (milliseconds)', example: 1704934800000 })
  peakTimestamp: number;

  @ApiProperty({ description: 'Number of unique client names', example: 45 })
  uniqueClientNames: number;

  @ApiProperty({ description: 'Number of unique users', example: 8 })
  uniqueUsers: number;

  @ApiProperty({ description: 'Number of unique IP addresses', example: 32 })
  uniqueIps: number;

  @ApiProperty({
    description: 'Connections grouped by client name',
    example: { 'app-1': { current: 5, peak: 10, avgAge: 3600 } },
  })
  connectionsByName: Record<string, { current: number; peak: number; avgAge: number }>;

  @ApiProperty({
    description: 'Connections grouped by user',
    example: { default: { current: 20, peak: 100 } },
  })
  connectionsByUser: Record<string, { current: number; peak: number }>;

  @ApiProperty({
    description: 'Connections grouped by user and name combination',
    example: { 'default:app-1': { user: 'default', name: 'app-1', current: 5, peak: 10, avgAge: 3600 } },
  })
  connectionsByUserAndName: Record<string, { user: string; name: string; current: number; peak: number; avgAge: number }>;

  @ApiProperty({
    description: 'Time range of data',
    example: { earliest: 1704934800000, latest: 1704938400000 },
    nullable: true,
  })
  timeRange: { earliest: number; latest: number } | null;
}

export class CleanupResponseDto {
  @ApiProperty({ description: 'Number of records pruned', example: 1000 })
  pruned: number;
}
