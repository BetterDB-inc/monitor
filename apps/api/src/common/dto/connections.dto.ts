import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsBoolean, IsOptional, Min, Max, MinLength, MaxLength } from 'class-validator';
import type {
  ConnectionStatus,
  ConnectionCapabilities,
  CreateConnectionRequest,
  TestConnectionResponse,
  ConnectionListResponse,
  CurrentConnectionResponse,
  AllConnectionsHealthResponse,
} from '@betterdb/shared';

/**
 * DTO for connection capabilities
 */
export class ConnectionCapabilitiesDto implements ConnectionCapabilities {
  @ApiProperty({ description: 'Database type', enum: ['valkey', 'redis'], example: 'valkey' })
  dbType: 'valkey' | 'redis';

  @ApiProperty({ description: 'Database version', example: '8.1.0' })
  version: string;

  @ApiPropertyOptional({ description: 'Whether COMMANDLOG is supported', example: true })
  supportsCommandLog?: boolean;

  @ApiPropertyOptional({ description: 'Whether CLUSTER SLOT-STATS is supported', example: true })
  supportsSlotStats?: boolean;
}

/**
 * DTO for connection status
 */
export class ConnectionStatusDto implements ConnectionStatus {
  @ApiProperty({ description: 'Unique connection identifier', example: 'env-default' })
  id: string;

  @ApiProperty({ description: 'Human-readable connection name', example: 'Production Redis' })
  name: string;

  @ApiProperty({ description: 'Database host', example: 'localhost' })
  host: string;

  @ApiProperty({ description: 'Database port', example: 6379 })
  port: number;

  @ApiPropertyOptional({ description: 'ACL username', example: 'default' })
  username?: string;

  @ApiPropertyOptional({ description: 'Database index (0-15)', example: 0 })
  dbIndex?: number;

  @ApiPropertyOptional({ description: 'Whether TLS is enabled', example: false })
  tls?: boolean;

  @ApiPropertyOptional({ description: 'Whether this is the default connection', example: true })
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Creation timestamp (Unix ms)', example: 1704067200000 })
  createdAt?: number;

  @ApiPropertyOptional({ description: 'Last update timestamp (Unix ms)', example: 1704067200000 })
  updatedAt?: number;

  @ApiProperty({ description: 'Whether the connection is currently active', example: true })
  isConnected: boolean;

  @ApiPropertyOptional({ description: 'Connection capabilities (only when connected)', type: ConnectionCapabilitiesDto })
  capabilities?: ConnectionCapabilities;
}

/**
 * DTO for creating a new connection
 */
export class CreateConnectionDto implements CreateConnectionRequest {
  @ApiProperty({ description: 'Human-readable connection name', example: 'Production Redis', minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Database host', example: 'localhost' })
  @IsString()
  @MinLength(1)
  host: string;

  @ApiProperty({ description: 'Database port', example: 6379, minimum: 1, maximum: 65535 })
  @IsNumber()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiPropertyOptional({ description: 'ACL username', example: 'default' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: 'ACL password' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ description: 'Database index (0-15)', example: 0, minimum: 0, maximum: 15 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(15)
  dbIndex?: number;

  @ApiPropertyOptional({ description: 'Whether to use TLS', example: false })
  @IsOptional()
  @IsBoolean()
  tls?: boolean;

  @ApiPropertyOptional({ description: 'Whether to set this as the default connection', example: false })
  @IsOptional()
  @IsBoolean()
  setAsDefault?: boolean;
}

/**
 * DTO for test connection response
 */
export class TestConnectionResponseDto implements TestConnectionResponse {
  @ApiProperty({ description: 'Whether the connection test succeeded', example: true })
  success: boolean;

  @ApiPropertyOptional({ description: 'Connection capabilities if successful', type: ConnectionCapabilitiesDto })
  capabilities?: ConnectionCapabilities;

  @ApiPropertyOptional({ description: 'Error message if failed', example: 'Connection refused' })
  error?: string;
}

/**
 * DTO for listing all connections
 */
export class ConnectionListResponseDto implements ConnectionListResponse {
  @ApiProperty({ description: 'List of all connections', type: [ConnectionStatusDto] })
  connections: ConnectionStatus[];

  @ApiProperty({ description: 'Current default connection ID', nullable: true, example: 'env-default' })
  currentId: string | null;
}

/**
 * DTO for current connection response
 */
export class CurrentConnectionResponseDto implements CurrentConnectionResponse {
  @ApiProperty({ description: 'Current default connection ID', nullable: true, example: 'env-default' })
  id: string | null;
}

/**
 * DTO for connection ID response
 */
export class ConnectionIdResponseDto {
  @ApiProperty({ description: 'Created connection ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;
}

/**
 * DTO for success response
 */
export class SuccessResponseDto {
  @ApiProperty({ description: 'Whether the operation succeeded', example: true })
  success: boolean;
}

/**
 * DTO for individual connection health in all-connections response
 */
export class ConnectionHealthDto {
  @ApiProperty({ description: 'Connection ID', example: 'env-default' })
  connectionId: string;

  @ApiProperty({ description: 'Connection name', example: 'Production Redis' })
  connectionName: string;

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
    type: string;
    version: string | null;
    host: string;
    port: number;
  };

  @ApiProperty({ description: 'Database capabilities', nullable: true })
  capabilities: unknown;

  @ApiPropertyOptional({ description: 'Error message if status is error', example: 'Connection refused' })
  error?: string;

  @ApiPropertyOptional({ description: 'Informational message for waiting or other states', example: 'Waiting for database connection to be configured' })
  message?: string;
}

/**
 * DTO for all connections health response
 */
export class AllConnectionsHealthResponseDto implements AllConnectionsHealthResponse {
  @ApiProperty({
    description: 'Overall health status across all connections',
    enum: ['healthy', 'degraded', 'unhealthy', 'waiting'],
    example: 'healthy',
  })
  overallStatus: 'healthy' | 'degraded' | 'unhealthy' | 'waiting';

  @ApiProperty({ description: 'Health status for each connection', type: [ConnectionHealthDto] })
  connections: ConnectionHealthDto[];

  @ApiProperty({ description: 'Timestamp when health was checked (Unix ms)', example: 1704067200000 })
  timestamp: number;

  @ApiPropertyOptional({ description: 'Informational message when waiting or in special states', example: 'Waiting for database connection to be configured' })
  message?: string;
}
