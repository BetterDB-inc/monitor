import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  FleetInstanceStatus,
  FleetInstanceSummary,
  FleetOverallStatus,
  FleetSummaryResponse,
} from '@betterdb/shared';

export class FleetInstanceSummaryDto implements FleetInstanceSummary {
  @ApiProperty({ description: 'Connection ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  connectionId: string;

  @ApiProperty({ description: 'Human-readable connection name', example: 'Production Valkey' })
  name: string;

  @ApiProperty({ description: 'Database host', example: 'localhost' })
  host: string;

  @ApiProperty({ description: 'Database port', example: 6379 })
  port: number;

  @ApiProperty({ description: 'Rollup status for this instance', enum: ['up', 'down', 'unknown'] })
  status: FleetInstanceStatus;

  @ApiProperty({ description: 'Server uptime in seconds (INFO server)', nullable: true, example: 86400 })
  uptimeSec: number | null;

  @ApiProperty({ description: 'Used memory in bytes (INFO memory)', nullable: true, example: 104857600 })
  memoryUsedBytes: number | null;

  @ApiProperty({ description: 'Maxmemory in bytes (INFO memory)', nullable: true, example: 536870912 })
  memoryMaxBytes: number | null;

  @ApiProperty({ description: 'Memory usage percent; null when maxmemory is 0 (no limit) or unknown', nullable: true, example: 19.5 })
  memPct: number | null;

  @ApiProperty({ description: 'Instantaneous ops/sec (INFO stats)', nullable: true, example: 1234 })
  opsPerSec: number | null;

  @ApiProperty({ description: 'Connected clients (INFO clients)', nullable: true, example: 42 })
  connectedClients: number | null;

  @ApiProperty({ description: 'Replication role (INFO replication)', nullable: true, example: 'master' })
  replicationRole: string | null;

  @ApiProperty({ description: 'Last successful collection (Unix ms); null when never seen up', nullable: true })
  lastSeen: number | null;

  @ApiPropertyOptional({ description: 'Error when the instance is down/unknown', example: 'Not connected to database' })
  error?: string;
}

export class FleetSummaryResponseDto implements FleetSummaryResponse {
  @ApiProperty({ description: 'Overall fleet status', enum: ['healthy', 'degraded', 'unhealthy', 'waiting'] })
  overallStatus: FleetOverallStatus;

  @ApiProperty({ description: 'Per-instance summaries', type: [FleetInstanceSummaryDto] })
  instances: FleetInstanceSummaryDto[];

  @ApiProperty({ description: 'Timestamp when the summary was collected (Unix ms)' })
  timestamp: number;
}
