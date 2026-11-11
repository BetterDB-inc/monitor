import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type {
  SlowLogEntry,
  CommandLogEntry,
  CommandLogType,
  LatencyEvent,
  LatencyHistoryEntry,
  LatencyHistogram,
  MemoryStats,
  ClientInfo,
  AclLogEntry,
  RoleInfo,
  ReplicaInfo,
  ClusterNode,
  SlotStatsMetric,
} from '../types/metrics.types';

/**
 * DTO for SlowLogEntry - mirrors metrics.types for Swagger documentation
 */
export class SlowLogEntryDto implements SlowLogEntry {
  @ApiProperty({ description: 'Unique entry ID', example: 123 })
  id: number;

  @ApiProperty({ description: 'Unix timestamp in microseconds', example: 1704934800000000 })
  timestamp: number;

  @ApiProperty({ description: 'Execution time in microseconds', example: 15000 })
  duration: number;

  @ApiProperty({ description: 'Command and arguments', type: [String], example: ['GET', 'user:123'] })
  command: string[];

  @ApiProperty({ description: 'Client address', example: '127.0.0.1:54321' })
  clientAddress: string;

  @ApiProperty({ description: 'Client name', example: 'app-server-1' })
  clientName: string;
}

/**
 * DTO for CommandLogEntry - mirrors metrics.types for Swagger documentation
 */
export class CommandLogEntryDto implements CommandLogEntry {
  @ApiProperty({ description: 'Unique entry ID', example: 456 })
  id: number;

  @ApiProperty({ description: 'Unix timestamp in microseconds', example: 1704934800000000 })
  timestamp: number;

  @ApiProperty({ description: 'Execution time in microseconds', example: 25000 })
  duration: number;

  @ApiProperty({ description: 'Command and arguments', type: [String], example: ['SET', 'key', 'value'] })
  command: string[];

  @ApiProperty({ description: 'Client address', example: '127.0.0.1:54321' })
  clientAddress: string;

  @ApiProperty({ description: 'Client name', example: 'app-server-1' })
  clientName: string;

  @ApiProperty({ description: 'Type of command log entry', enum: ['slow', 'large-request', 'large-reply'], example: 'slow' })
  type: CommandLogType;
}

/**
 * DTO for LatencyEvent - mirrors metrics.types for Swagger documentation
 */
export class LatencyEventDto implements LatencyEvent {
  @ApiProperty({ description: 'Event name', example: 'command' })
  eventName: string;

  @ApiProperty({ description: 'Latency in milliseconds', example: 150 })
  latency: number;

  @ApiProperty({ description: 'Unix timestamp in seconds', example: 1704934800 })
  timestamp: number;
}

/**
 * DTO for LatencyHistoryEntry - mirrors metrics.types for Swagger documentation
 */
export class LatencyHistoryEntryDto implements LatencyHistoryEntry {
  @ApiProperty({ description: 'Unix timestamp in seconds', example: 1704934800 })
  timestamp: number;

  @ApiProperty({ description: 'Latency in milliseconds', example: 120 })
  latency: number;
}

/**
 * DTO for LatencyHistogram - mirrors metrics.types for Swagger documentation
 */
export class LatencyHistogramDto implements LatencyHistogram {
  @ApiProperty({ description: 'Number of calls', example: 1000 })
  calls: number;

  @ApiProperty({ description: 'Histogram buckets mapping bucket to count', example: { '1': 100, '2': 200, '5': 500 } })
  histogram: Record<string, number>;
}

/**
 * DTO for MemoryStats - mirrors metrics.types for Swagger documentation
 * Note: actual response may contain additional dynamic fields ([key: string]: unknown)
 */
export class MemoryStatsDto {
  @ApiProperty({ description: 'Peak allocated memory in bytes', example: 10485760 })
  peakAllocated: number;

  @ApiProperty({ description: 'Total allocated memory in bytes', example: 8388608 })
  totalAllocated: number;

  @ApiProperty({ description: 'Startup allocated memory in bytes', example: 1048576 })
  startupAllocated: number;

  @ApiProperty({ description: 'Replication backlog memory in bytes', example: 524288 })
  replicationBacklog: number;

  @ApiProperty({ description: 'Normal clients memory in bytes', example: 262144 })
  clientsNormal: number;

  @ApiProperty({ description: 'Replica clients memory in bytes', example: 131072 })
  clientsReplicas: number;

  @ApiProperty({ description: 'AOF buffer memory in bytes', example: 65536 })
  aofBuffer: number;

  @ApiProperty({ description: 'DB dictionary overhead in bytes', example: 2097152 })
  dbDict: number;

  @ApiProperty({ description: 'DB expires overhead in bytes', example: 1048576 })
  dbExpires: number;
}

/**
 * DTO for ClientInfo - mirrors metrics.types for Swagger documentation
 * Note: actual response may contain additional dynamic fields ([key: string]: unknown)
 */
export class ClientInfoDto {
  @ApiProperty({ description: 'Client ID', example: '123' })
  id: string;

  @ApiProperty({ description: 'Client address', example: '127.0.0.1:54321' })
  addr: string;

  @ApiProperty({ description: 'Client name', example: 'app-server-1' })
  name: string;

  @ApiProperty({ description: 'Client age in seconds', example: 3600 })
  age: number;

  @ApiProperty({ description: 'Idle time in seconds', example: 10 })
  idle: number;

  @ApiProperty({ description: 'Client flags', example: 'N' })
  flags: string;

  @ApiProperty({ description: 'Database number', example: 0 })
  db: number;

  @ApiProperty({ description: 'Number of channel subscriptions', example: 0 })
  sub: number;

  @ApiProperty({ description: 'Number of pattern subscriptions', example: 0 })
  psub: number;

  @ApiProperty({ description: 'Number of commands in multi/exec context', example: 0 })
  multi: number;

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

  @ApiProperty({ description: 'File descriptor events', example: 'r' })
  events: string;

  @ApiProperty({ description: 'Last command executed', example: 'GET' })
  cmd: string;

  @ApiProperty({ description: 'Authenticated username', example: 'default' })
  user: string;
}

/**
 * DTO for AclLogEntry - mirrors metrics.types for Swagger documentation
 */
export class AclLogEntryDto implements AclLogEntry {
  @ApiProperty({ description: 'Number of times this entry occurred', example: 5 })
  count: number;

  @ApiProperty({ description: 'Reason for ACL failure', enum: ['auth', 'command', 'key', 'channel'], example: 'auth' })
  reason: string;

  @ApiProperty({ description: 'Context of the failure', example: 'toplevel' })
  context: string;

  @ApiProperty({ description: 'Object involved in the failure', example: 'AUTH' })
  object: string;

  @ApiProperty({ description: 'Username that triggered the entry', example: 'guest' })
  username: string;

  @ApiProperty({ description: 'Age of the entry in seconds', example: 3600 })
  ageSeconds: number;

  @ApiProperty({ description: 'Client information string', example: 'id=123 addr=127.0.0.1:54321' })
  clientInfo: string;

  @ApiProperty({ description: 'Unix timestamp when entry was created', example: 1704934800 })
  timestampCreated: number;

  @ApiProperty({ description: 'Unix timestamp when entry was last updated', example: 1704938400 })
  timestampLastUpdated: number;
}

/**
 * DTO for ReplicaInfo - mirrors metrics.types for Swagger documentation
 */
export class ReplicaInfoDto implements ReplicaInfo {
  @ApiProperty({ description: 'Replica IP address', example: '192.168.1.100' })
  ip: string;

  @ApiProperty({ description: 'Replica port', example: 6379 })
  port: number;

  @ApiProperty({ description: 'Replica state', example: 'online' })
  state: string;

  @ApiProperty({ description: 'Replication offset', example: 12345678 })
  offset: number;

  @ApiProperty({ description: 'Replication lag in seconds', example: 0 })
  lag: number;
}

/**
 * DTO for RoleInfo - mirrors metrics.types for Swagger documentation
 */
export class RoleInfoDto implements RoleInfo {
  @ApiProperty({ description: 'Server role', enum: ['master', 'slave', 'sentinel'], example: 'master' })
  role: 'master' | 'slave' | 'sentinel';

  @ApiPropertyOptional({ description: 'Replication offset (for master)', example: 12345678 })
  replicationOffset?: number;

  @ApiPropertyOptional({ description: 'Connected replicas (for master)', type: [ReplicaInfoDto] })
  replicas?: ReplicaInfo[];

  @ApiPropertyOptional({ description: 'Master host (for slave)', example: '192.168.1.10' })
  masterHost?: string;

  @ApiPropertyOptional({ description: 'Master port (for slave)', example: 6379 })
  masterPort?: number;

  @ApiPropertyOptional({ description: 'Master link status (for slave)', example: 'up' })
  masterLinkStatus?: string;

  @ApiPropertyOptional({ description: 'Master replication offset (for slave)', example: 12345678 })
  masterReplicationOffset?: number;
}

/**
 * DTO for ClusterNode - mirrors metrics.types for Swagger documentation
 */
export class ClusterNodeDto implements ClusterNode {
  @ApiProperty({ description: 'Node ID', example: 'abc123def456...' })
  id: string;

  @ApiProperty({ description: 'Node address', example: '127.0.0.1:6379' })
  address: string;

  @ApiProperty({ description: 'Node flags', type: [String], example: ['master', 'myself'] })
  flags: string[];

  @ApiProperty({ description: 'Master node ID (- if master)', example: '-' })
  master: string;

  @ApiProperty({ description: 'Ping sent timestamp', example: 0 })
  pingSent: number;

  @ApiProperty({ description: 'Pong received timestamp', example: 1704934800000 })
  pongReceived: number;

  @ApiProperty({ description: 'Configuration epoch', example: 1 })
  configEpoch: number;

  @ApiProperty({ description: 'Link state', example: 'connected' })
  linkState: string;

  @ApiProperty({ description: 'Slot ranges [[start, end], ...]', type: 'array', example: [[0, 5460]] })
  slots: number[][];

  @ApiPropertyOptional({
    description: 'Availability zone the node reports in CLUSTER SHARDS (Valkey 9.1+, when the node has one set)',
    example: 'us-east-1a',
  })
  availabilityZone?: string;

  @ApiPropertyOptional({
    description: 'Id of the shard the node belongs to, from CLUSTER SHARDS (Valkey 9.1+)',
    example: '7c9e1b0f5a3d4e6f8a2b1c0d9e8f7a6b5c4d3e2f',
  })
  shardId?: string;
}

/**
 * DTO for SlotStatsMetric - mirrors metrics.types for Swagger documentation
 */
export class SlotStatsMetricDto implements SlotStatsMetric {
  @ApiProperty({ description: 'Number of keys in slot', example: 100 })
  key_count: number;

  @ApiPropertyOptional({
    description: 'CPU time spent on the slot in microseconds, cumulative. Only with cluster-slot-stats-enabled',
    example: 1200,
  })
  cpu_usec?: number;

  @ApiPropertyOptional({ description: 'Bytes received for commands on the slot', example: 4096 })
  network_bytes_in?: number;

  @ApiPropertyOptional({ description: 'Bytes sent in replies for the slot', example: 8192 })
  network_bytes_out?: number;
}

// Simple response DTOs for common patterns

export class GenericSuccessDto {
  @ApiProperty({ description: 'Operation success status', example: true })
  success: boolean;
}

export class LengthResponseDto {
  @ApiProperty({ description: 'Length value', example: 100 })
  length: number;
}

export class ReportResponseDto {
  @ApiProperty({ description: 'Report text', example: 'No latency issues detected.' })
  report: string;
}

export class KilledResponseDto {
  @ApiProperty({ description: 'Number of clients killed', example: 5 })
  killed: number;
}

export class ConfigValueResponseDto {
  @ApiProperty({ description: 'Configuration value', nullable: true, example: 'yes' })
  value: string | null;
}

export class DbSizeResponseDto {
  @ApiProperty({ description: 'Database size (number of keys)', example: 10000 })
  size: number;
}

export class LastSaveResponseDto {
  @ApiProperty({ description: 'Unix timestamp of last save', example: 1704934800 })
  timestamp: number;
}

// Cluster-specific DTOs

export class DiscoveredNodeDto {
  @ApiProperty({ description: 'Node ID', example: 'abc123def456...' })
  id: string;

  @ApiProperty({ description: 'Node address (host:port)', example: '127.0.0.1:6379' })
  address: string;

  @ApiProperty({ description: 'Node role', enum: ['master', 'replica'], example: 'master' })
  role: 'master' | 'replica';

  @ApiPropertyOptional({ description: 'Master node ID (for replicas)', example: 'xyz789abc123...' })
  masterId?: string;

  @ApiProperty({ description: 'Slot ranges [[start, end], ...]', type: 'array', example: [[0, 5460]] })
  slots: number[][];

  @ApiProperty({ description: 'Node health status', example: true })
  healthy: boolean;

  @ApiPropertyOptional({
    description: 'Availability zone the node reports in CLUSTER SHARDS (Valkey 9.1+, when the node has one set)',
    example: 'us-east-1a',
  })
  availabilityZone?: string;

  @ApiPropertyOptional({
    description: 'Id of the shard the node belongs to, from CLUSTER SHARDS (Valkey 9.1+)',
    example: '7c9e1b0f5a3d4e6f8a2b1c0d9e8f7a6b5c4d3e2f',
  })
  shardId?: string;
}

export class NodeStatsDto {
  @ApiProperty({ description: 'Node ID', example: 'abc123def456...' })
  nodeId: string;

  @ApiProperty({ description: 'Node address', example: '127.0.0.1:6379' })
  nodeAddress: string;

  @ApiProperty({ description: 'Node role', enum: ['master', 'replica'], example: 'master' })
  role: 'master' | 'replica';

  @ApiProperty({ description: 'Memory used in bytes', example: 10485760 })
  memoryUsed: number;

  @ApiProperty({ description: 'Peak memory used in bytes', example: 12582912 })
  memoryPeak: number;

  @ApiProperty({ description: 'Memory fragmentation ratio', example: 1.2 })
  memoryFragmentationRatio: number;

  @ApiProperty({ description: 'Operations per second', example: 1000 })
  opsPerSec: number;

  @ApiProperty({ description: 'Connected clients count', example: 50 })
  connectedClients: number;

  @ApiProperty({ description: 'Blocked clients count', example: 2 })
  blockedClients: number;

  @ApiProperty({ description: 'Input traffic in kbps', example: 100.5 })
  inputKbps: number;

  @ApiProperty({ description: 'Output traffic in kbps', example: 200.5 })
  outputKbps: number;

  @ApiPropertyOptional({ description: 'Replication offset', example: 12345678 })
  replicationOffset?: number;

  @ApiPropertyOptional({ description: 'Master link status (for replicas)', example: 'up' })
  masterLinkStatus?: string;

  @ApiPropertyOptional({ description: 'Master last IO seconds ago (for replicas)', example: 0 })
  masterLastIoSecondsAgo?: number;

  @ApiPropertyOptional({ description: 'CPU system time', example: 10.5 })
  cpuSys?: number;

  @ApiPropertyOptional({ description: 'CPU user time', example: 20.3 })
  cpuUser?: number;

  @ApiPropertyOptional({ description: 'Uptime in seconds', example: 86400 })
  uptimeSeconds?: number;
}

export class ClusterSlowlogEntryDto extends SlowLogEntryDto {
  @ApiProperty({ description: 'Source node ID', example: 'abc123def456...' })
  nodeId: string;

  @ApiProperty({ description: 'Source node address', example: '127.0.0.1:6379' })
  nodeAddress: string;
}

export class ClusterClientEntryDto extends ClientInfoDto {
  @ApiProperty({ description: 'Source node ID', example: 'abc123def456...' })
  nodeId: string;

  @ApiProperty({ description: 'Source node address', example: '127.0.0.1:6379' })
  nodeAddress: string;
}

export class ClusterCommandlogEntryDto extends CommandLogEntryDto {
  @ApiProperty({ description: 'Source node ID', example: 'abc123def456...' })
  nodeId: string;

  @ApiProperty({ description: 'Source node address', example: '127.0.0.1:6379' })
  nodeAddress: string;
}

export class SlotMigrationDto {
  @ApiProperty({ description: 'Slot number', example: 5461 })
  slot: number;

  @ApiProperty({ description: 'Source node ID', example: 'abc123def456...' })
  sourceNodeId: string;

  @ApiProperty({ description: 'Source node address', example: '127.0.0.1:6379' })
  sourceAddress: string;

  @ApiProperty({ description: 'Target node ID', example: 'xyz789abc123...' })
  targetNodeId: string;

  @ApiProperty({ description: 'Target node address', example: '127.0.0.1:6380' })
  targetAddress: string;

  @ApiProperty({ description: 'Migration state', enum: ['migrating', 'importing'], example: 'migrating' })
  state: 'migrating' | 'importing';

  @ApiPropertyOptional({ description: 'Number of keys remaining to migrate', example: 2450 })
  keysRemaining?: number;

  @ApiPropertyOptional({
    description: 'Atomic slot migration (Valkey 9+): the slot ranges the job moves',
    example: '0-1365 5462-6826',
  })
  slotRange?: string;

  @ApiPropertyOptional({ description: 'Atomic slot migration job state as Valkey reports it', example: 'snapshotting' })
  phase?: string;
}
