import { Controller, Get, Query, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { StoragePort, StoredAclEntry, AuditStats } from '../common/interfaces/storage-port.interface';

@Controller('audit')
export class AuditController {
  constructor(
    @Inject('STORAGE_CLIENT')
    private readonly storageClient: StoragePort,
  ) {}

  @Get('entries')
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
        startTime: startTime ? parseInt(startTime, 10) : undefined,
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
  async getStats(@Query('startTime') startTime?: string, @Query('endTime') endTime?: string): Promise<AuditStats> {
    try {
      return await this.storageClient.getAuditStats(
        startTime ? parseInt(startTime, 10) : undefined,
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
  async getFailedAuth(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredAclEntry[]> {
    try {
      const options = {
        reason: 'auth',
        startTime: startTime ? parseInt(startTime, 10) : undefined,
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
        startTime: startTime ? parseInt(startTime, 10) : undefined,
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
