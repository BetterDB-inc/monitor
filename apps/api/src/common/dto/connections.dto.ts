import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsInt, IsBoolean, IsOptional, IsIn, Min, Max, MinLength, MaxLength, ValidateNested, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { ENV_DEFAULT_ID } from '../../connections/connection.constants';
import type {
  ConnectionStatus,
  ConnectionCapabilities,
  CreateConnectionRequest,
  TestConnectionResponse,
  ConnectionListResponse,
  CurrentConnectionResponse,
  AllConnectionsHealthResponse,
  SshTunnelInput,
  SshAuthMethod,
  SshKeySource,
  TopologyMembership,
  TopologyMembershipOrigin,
  TopologyKind,
  TopologyRole,
} from '@betterdb/shared';

/**
 * DTO for an SSH tunnel used to reach the database.
 *
 * Implements `SshTunnelInput` (not `SshTunnelConfig`) so `secretsEncrypted` can
 * never be asserted by a caller — it is set server-side only after encryption.
 */
export class SshTunnelDto implements SshTunnelInput {
  @ApiProperty({ description: 'Whether the SSH tunnel is enabled', example: true })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({ description: 'SSH server (bastion) host', example: 'bastion.example.com' })
  @IsString()
  @MinLength(1)
  host: string;

  @ApiProperty({ description: 'SSH server port', example: 22, minimum: 1, maximum: 65535 })
  @IsNumber()
  @Min(1)
  @Max(65535)
  port: number;

  @ApiProperty({ description: 'SSH username', example: 'ec2-user' })
  @IsString()
  @MinLength(1)
  username: string;

  @ApiProperty({ description: 'SSH authentication method', enum: ['password', 'privateKey'], example: 'privateKey' })
  @IsIn(['password', 'privateKey'])
  authMethod: SshAuthMethod;

  @ApiPropertyOptional({ description: 'Password for password auth' })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ description: "Private key source: 'inline' content or server-side 'file'", enum: ['inline', 'file'], example: 'inline' })
  @IsOptional()
  @IsIn(['inline', 'file'])
  keySource?: SshKeySource;

  @ApiPropertyOptional({ description: 'Inline PEM private key content (keySource=inline)' })
  @IsOptional()
  @IsString()
  privateKey?: string;

  @ApiPropertyOptional({ description: 'Server-side private key path (keySource=file); must be inside BETTERDB_SSH_KEY_DIR' })
  @IsOptional()
  @IsString()
  privateKeyPath?: string;

  @ApiPropertyOptional({ description: 'Passphrase protecting the private key' })
  @IsOptional()
  @IsString()
  passphrase?: string;

  @ApiPropertyOptional({ description: 'Pinned SSH host-key fingerprint (SHA256:<base64>) to verify the server against' })
  @IsOptional()
  @IsString()
  hostKeyFingerprint?: string;
}

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

  @ApiPropertyOptional({ description: 'Whether cluster mode is enabled on this server', example: false })
  clusterEnabled?: boolean;
}

/**
 * DTO for topology membership (auto-registered or adopted cluster/sentinel node)
 */
export class TopologyMembershipDto implements TopologyMembership {
  @ApiProperty({ description: 'Connection ID of the seed that owns this membership', example: ENV_DEFAULT_ID })
  seedId: string;

  @ApiProperty({ description: 'Node identifier within the topology', example: 'abc123' })
  nodeId: string;

  @ApiProperty({ description: 'How this membership was created', enum: ['auto', 'adopted'], example: 'auto' })
  origin: TopologyMembershipOrigin;

  @ApiProperty({ description: 'Topology kind this membership belongs to', enum: ['cluster', 'sentinel'], example: 'cluster' })
  source: TopologyKind;

  @ApiPropertyOptional({ description: 'Sentinel group name (master name)', example: 'mymaster' })
  group?: string;

  @ApiPropertyOptional({ description: 'Role within the topology', enum: ['primary', 'replica'], example: 'primary' })
  role?: TopologyRole;

  @ApiPropertyOptional({ description: 'Retirement timestamp (Unix ms), set when the node is no longer part of the topology', example: 1704067200000 })
  retiredAt?: number;
}

/**
 * DTO for connection status
 */
export class ConnectionStatusDto implements ConnectionStatus {
  @ApiProperty({ description: 'Unique connection identifier', example: ENV_DEFAULT_ID })
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

  @ApiPropertyOptional({
    description: 'Auto-register discovered nodes (cluster or Sentinel); undefined/null follows CLUSTER_AUTO_REGISTER_NODES or SENTINEL_AUTO_REGISTER_NODES',
    example: true,
  })
  autoRegisterNodes?: boolean;

  @ApiPropertyOptional({ description: 'Cluster membership details when this connection was registered as a cluster node', type: TopologyMembershipDto })
  membership?: TopologyMembership;
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

  @ApiPropertyOptional({ description: 'Username for data nodes discovered through this Sentinel; defaults to username' })
  @IsOptional()
  @IsString()
  nodeUsername?: string;

  @ApiPropertyOptional({ description: 'Password for data nodes discovered through this Sentinel; defaults to password' })
  @IsOptional()
  @IsString()
  nodePassword?: string;

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

  @ApiPropertyOptional({ description: 'Optional SSH tunnel used to reach the database', type: SshTunnelDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SshTunnelDto)
  sshTunnel?: SshTunnelDto;

  @ApiPropertyOptional({ description: 'Whether to set this as the default connection', example: false })
  @IsOptional()
  @IsBoolean()
  setAsDefault?: boolean;

  @ApiPropertyOptional({ enum: ['direct', 'external'], description: 'direct (polled) or external (OTLP push)' })
  @IsOptional()
  @IsIn(['direct', 'external'])
  connectionType?: 'direct' | 'external';

  @ApiPropertyOptional({ description: 'Host the OTLP collector pushes under, when it differs from host (external only)', maxLength: 253 })
  @IsOptional()
  @IsString()
  @MaxLength(253)
  discoveredHost?: string;

  @ApiPropertyOptional({ description: 'Port the OTLP collector pushes under, when it differs from port (external only)', minimum: 1, maximum: 65535 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  discoveredPort?: number;
}

export class DismissDiscoveredDto {
  @ApiProperty({ description: 'Discovered instance host', example: 'cache.internal' })
  @IsString()
  @MinLength(1)
  @MaxLength(253)
  host: string;

  @ApiProperty({ description: 'Discovered instance port', example: 6379 })
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;
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

  @ApiPropertyOptional()
  message?: string;
}

/**
 * DTO for listing all connections
 */
export class ConnectionListResponseDto implements ConnectionListResponse {
  @ApiProperty({ description: 'List of all connections', type: [ConnectionStatusDto] })
  connections: ConnectionStatus[];

  @ApiProperty({ description: 'Current default connection ID', nullable: true, example: ENV_DEFAULT_ID })
  currentId: string | null;

  @ApiProperty({ description: 'Auto-register default applied to seeds that have not set the flag (CLUSTER_AUTO_REGISTER_NODES)', example: false })
  autoRegisterNodesDefault: boolean;

  @ApiProperty({ description: 'Auto-register default applied to Sentinel seeds that have not set the flag (SENTINEL_AUTO_REGISTER_NODES)', example: false })
  autoRegisterSentinelNodesDefault: boolean;
}

/**
 * DTO for current connection response
 */
export class CurrentConnectionResponseDto implements CurrentConnectionResponse {
  @ApiProperty({ description: 'Current default connection ID', nullable: true, example: ENV_DEFAULT_ID })
  id: string | null;
}

/**
 * DTO for connection ID response
 */
export class ConnectionIdResponseDto {
  @ApiProperty({ description: 'Created connection ID', example: '550e8400-e29b-41d4-a716-446655440000' })
  id: string;
}

export class SetAutoRegisterDto {
  @ApiProperty({
    description: 'Auto-register discovered nodes (cluster or Sentinel); undefined/null follows CLUSTER_AUTO_REGISTER_NODES or SENTINEL_AUTO_REGISTER_NODES',
    nullable: true,
    type: Boolean,
  })
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  enabled: boolean | null;
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
  @ApiProperty({ description: 'Connection ID', example: ENV_DEFAULT_ID })
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
