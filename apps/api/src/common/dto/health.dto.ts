import { ApiProperty } from '@nestjs/swagger';
import type { HealthResponse, DatabaseCapabilities } from '@betterdb/shared';

/**
 * DTO for DatabaseCapabilities - mirrors the shared interface for Swagger documentation
 */
export class DatabaseCapabilitiesDto implements DatabaseCapabilities {
  @ApiProperty({ description: 'Database type', enum: ['valkey', 'redis'], example: 'valkey' })
  dbType: 'valkey' | 'redis';

  @ApiProperty({ description: 'Database version', example: '8.1.0' })
  version: string;

  @ApiProperty({ description: 'Whether COMMANDLOG is supported', example: true })
  hasCommandLog: boolean;

  @ApiProperty({ description: 'Whether CLUSTER SLOT-STATS is supported', example: true })
  hasSlotStats: boolean;

  @ApiProperty({ description: 'Whether CLUSTER SLOT-STATS is supported (alias)', example: true })
  hasClusterSlotStats: boolean;

  @ApiProperty({ description: 'Whether LATENCY monitoring is supported', example: true })
  hasLatencyMonitor: boolean;

  @ApiProperty({ description: 'Whether ACL LOG is supported', example: true })
  hasAclLog: boolean;

  @ApiProperty({ description: 'Whether MEMORY DOCTOR is supported', example: true })
  hasMemoryDoctor: boolean;

  @ApiProperty({ description: 'Whether CONFIG command is available (disabled on some managed services like AWS ElastiCache)', example: true })
  hasConfig: boolean;
}

/**
 * DTO for HealthResponse - mirrors the shared interface for Swagger documentation
 */
export class HealthResponseDto implements HealthResponse {
  @ApiProperty({
    description: 'Connection status',
    enum: ['connected', 'disconnected', 'error', 'waiting'],
    example: 'connected'
  })
  status: 'connected' | 'disconnected' | 'error' | 'waiting';

  @ApiProperty({
    description: 'Database connection details',
    example: { type: 'valkey', version: '8.1.0', host: 'localhost', port: 6379 },
  })
  database: {
    type: 'valkey' | 'redis' | 'unknown';
    version: string | null;
    host: string;
    port: number;
  };

  @ApiProperty({
    description: 'Database capabilities',
    type: DatabaseCapabilitiesDto,
    nullable: true,
  })
  capabilities: DatabaseCapabilities | null;

  @ApiProperty({ description: 'Error message if status is error', required: false, example: 'Connection refused' })
  error?: string;

  @ApiProperty({ description: 'Informational message for waiting or other states', required: false, example: 'Waiting for database connection to be configured' })
  message?: string;
}
