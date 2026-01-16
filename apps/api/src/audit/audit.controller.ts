import { Controller, Get, Query, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { StoragePort, StoredAclEntry, AuditStats } from '../common/interfaces/storage-port.interface';
import { StoredAclEntryDto, AuditStatsDto } from '../common/dto/audit.dto';
import { RetentionService } from '@proprietary/license';

@ApiTags('audit')
@Controller('audit')
export class AuditController {
  constructor(
    @Inject('STORAGE_CLIENT')
    private readonly storageClient: StoragePort,
    private readonly retention: RetentionService,
  ) {}

  private enforceAclRetention(startTime?: string): number {
    const retentionCutoff = Math.floor(this.retention.getAclRetentionCutoff().getTime() / 1000);
    const requestedStartTime = startTime ? parseInt(startTime, 10) : undefined;
    return requestedStartTime ? Math.max(requestedStartTime, retentionCutoff) : retentionCutoff;
  }

  @Get('entries')
  @ApiOperation({ summary: 'Get audit entries', description: 'Retrieve persisted ACL audit log entries with optional filters' })
  @ApiQuery({ name: 'username', required: false, description: 'Filter by username' })
  @ApiQuery({ name: 'reason', required: false, description: 'Filter by failure reason (auth, command, key, channel)' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter by start timestamp (Unix seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter by end timestamp (Unix seconds)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of entries to skip' })
  @ApiResponse({ status: 200, description: 'Audit entries retrieved successfully', type: [StoredAclEntryDto] })
  @ApiResponse({ status: 500, description: 'Failed to get audit entries' })
  async getEntries(
    @Query('username') username?: string,
    @Query('reason') reason?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredAclEntry[]> {
    try {
      const options = {
        username,
        reason,
        startTime: this.enforceAclRetention(startTime),
        endTime: endTime ? parseInt(endTime, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      };

      return await this.storageClient.getAclEntries(options);
    } catch (error) {
      throw new HttpException(
        `Failed to get audit entries: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get audit statistics', description: 'Retrieve aggregated statistics about audit log entries' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter by start timestamp (Unix seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter by end timestamp (Unix seconds)' })
  @ApiResponse({ status: 200, description: 'Audit statistics retrieved successfully', type: AuditStatsDto })
  @ApiResponse({ status: 500, description: 'Failed to get audit statistics' })
  async getStats(@Query('startTime') startTime?: string, @Query('endTime') endTime?: string): Promise<AuditStats> {
    try {
      return await this.storageClient.getAuditStats(
        this.enforceAclRetention(startTime),
        endTime ? parseInt(endTime, 10) : undefined,
      );
    } catch (error) {
      throw new HttpException(
        `Failed to get audit stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('failed-auth')
  @ApiOperation({ summary: 'Get failed authentication attempts', description: 'Retrieve audit entries for failed authentication attempts' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter by start timestamp (Unix seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter by end timestamp (Unix seconds)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of entries to skip' })
  @ApiResponse({ status: 200, description: 'Failed auth attempts retrieved successfully', type: [StoredAclEntryDto] })
  @ApiResponse({ status: 500, description: 'Failed to get failed auth entries' })
  async getFailedAuth(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredAclEntry[]> {
    try {
      const options = {
        reason: 'auth',
        startTime: this.enforceAclRetention(startTime),
        endTime: endTime ? parseInt(endTime, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      };

      return await this.storageClient.getAclEntries(options);
    } catch (error) {
      throw new HttpException(
        `Failed to get failed auth entries: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('by-user')
  @ApiOperation({ summary: 'Get audit entries by username', description: 'Retrieve audit entries for a specific username' })
  @ApiQuery({ name: 'username', required: true, description: 'Username to filter by' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter by start timestamp (Unix seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter by end timestamp (Unix seconds)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of entries to skip' })
  @ApiResponse({ status: 200, description: 'Audit entries retrieved successfully', type: [StoredAclEntryDto] })
  @ApiResponse({ status: 400, description: 'Username query parameter is required' })
  @ApiResponse({ status: 500, description: 'Failed to get entries by user' })
  async getByUser(
    @Query('username') username: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredAclEntry[]> {
    try {
      if (!username) {
        throw new HttpException('username query parameter is required', HttpStatus.BAD_REQUEST);
      }

      const options = {
        username,
        startTime: this.enforceAclRetention(startTime),
        endTime: endTime ? parseInt(endTime, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      };

      return await this.storageClient.getAclEntries(options);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        `Failed to get entries by user: ${error instanceof Error ? error.message : 'Unknown error'}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
