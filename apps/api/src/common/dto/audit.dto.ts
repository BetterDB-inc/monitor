import { ApiProperty } from '@nestjs/swagger';
import type { StoredAclEntry, AuditStats } from '@betterdb/shared';

/**
 * DTO for StoredAclEntry - mirrors the shared interface for Swagger documentation
 */
export class StoredAclEntryDto implements StoredAclEntry {
  @ApiProperty({ description: 'Entry ID', example: 1 })
  id: number;

  @ApiProperty({ description: 'Number of times this event occurred', example: 3 })
  count: number;

  @ApiProperty({ description: 'Reason for ACL failure', enum: ['auth', 'command', 'key', 'channel'], example: 'auth' })
  reason: string;

  @ApiProperty({ description: 'Context of the failure', example: 'toplevel' })
  context: string;

  @ApiProperty({ description: 'Object involved (command or key)', example: 'AUTH' })
  object: string;

  @ApiProperty({ description: 'Username that triggered the entry', example: 'guest' })
  username: string;

  @ApiProperty({ description: 'Age in seconds since entry was created', example: 3600 })
  ageSeconds: number;

  @ApiProperty({ description: 'Client connection information', example: 'id=123 addr=127.0.0.1:54321' })
  clientInfo: string;

  @ApiProperty({ description: 'Unix timestamp when first created (seconds)', example: 1704934800 })
  timestampCreated: number;

  @ApiProperty({ description: 'Unix timestamp when last updated (seconds)', example: 1704938400 })
  timestampLastUpdated: number;

  @ApiProperty({ description: 'Unix timestamp when captured (seconds)', example: 1704938400 })
  capturedAt: number;

  @ApiProperty({ description: 'Source host where entry was captured', example: 'localhost' })
  sourceHost: string;

  @ApiProperty({ description: 'Source port where entry was captured', example: 6379 })
  sourcePort: number;
}

/**
 * DTO for AuditStats - mirrors the shared interface for Swagger documentation
 */
export class AuditStatsDto implements AuditStats {
  @ApiProperty({ description: 'Total number of audit entries', example: 150 })
  totalEntries: number;

  @ApiProperty({ description: 'Number of unique users', example: 12 })
  uniqueUsers: number;

  @ApiProperty({ description: 'Entry counts by failure reason', example: { auth: 45, command: 32, key: 18 } })
  entriesByReason: Record<string, number>;

  @ApiProperty({ description: 'Entry counts by username', example: { guest: 100, admin: 50 } })
  entriesByUser: Record<string, number>;

  @ApiProperty({
    description: 'Time range of entries',
    example: { earliest: 1704934800, latest: 1704938400 },
    nullable: true,
  })
  timeRange: { earliest: number; latest: number } | null;
}
