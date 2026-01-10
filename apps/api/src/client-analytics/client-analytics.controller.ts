import { Controller, Get, Delete, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ClientAnalyticsService } from './client-analytics.service';
import {
  StoredClientSnapshot,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
} from '../common/interfaces/storage-port.interface';
import {
  StoredClientSnapshotDto,
  ClientTimeSeriesPointDto,
  ClientAnalyticsStatsDto,
  CleanupResponseDto,
} from '../common/dto/client-analytics.dto';

@ApiTags('client-analytics')
@Controller('client-analytics')
export class ClientAnalyticsController {
  constructor(private service: ClientAnalyticsService) {}

  @Get('snapshots')
  @ApiOperation({ summary: 'Get client snapshots', description: 'Retrieve historical client connection snapshots with filters' })
  @ApiQuery({ name: 'name', required: false, description: 'Filter by client name' })
  @ApiQuery({ name: 'user', required: false, description: 'Filter by authenticated username' })
  @ApiQuery({ name: 'addr', required: false, description: 'Filter by client address' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter by start timestamp (Unix milliseconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter by end timestamp (Unix milliseconds)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of snapshots to return (default: 100)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of snapshots to skip (default: 0)' })
  @ApiResponse({ status: 200, description: 'Client snapshots retrieved successfully', type: [StoredClientSnapshotDto] })
  @ApiResponse({ status: 500, description: 'Failed to get snapshots' })
  async getSnapshots(
    @Query('name') name?: string,
    @Query('user') user?: string,
    @Query('addr') addr?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredClientSnapshot[]> {
    return this.service.getSnapshots({
      clientName: name,
      user,
      addr,
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get('timeseries')
  @ApiOperation({ summary: 'Get client count time series', description: 'Retrieve aggregated client connection counts over time' })
  @ApiQuery({ name: 'startTime', required: true, description: 'Start timestamp (Unix milliseconds)' })
  @ApiQuery({ name: 'endTime', required: true, description: 'End timestamp (Unix milliseconds)' })
  @ApiQuery({ name: 'bucketSize', required: false, description: 'Bucket size in milliseconds (default: 60000)' })
  @ApiResponse({ status: 200, description: 'Time series data retrieved successfully', type: [ClientTimeSeriesPointDto] })
  @ApiResponse({ status: 500, description: 'Failed to get time series' })
  async getTimeSeries(
    @Query('startTime') startTime: string,
    @Query('endTime') endTime: string,
    @Query('bucketSize') bucketSize?: string,
  ): Promise<ClientTimeSeriesPoint[]> {
    return this.service.getTimeSeries(
      parseInt(startTime, 10),
      parseInt(endTime, 10),
      bucketSize ? parseInt(bucketSize, 10) : 60000,
    );
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get client analytics statistics', description: 'Retrieve aggregated statistics about client connections' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter by start timestamp (Unix milliseconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter by end timestamp (Unix milliseconds)' })
  @ApiResponse({ status: 200, description: 'Client analytics statistics retrieved successfully', type: ClientAnalyticsStatsDto })
  @ApiResponse({ status: 500, description: 'Failed to get stats' })
  async getStats(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<ClientAnalyticsStats> {
    return this.service.getStats(
      startTime ? parseInt(startTime, 10) : undefined,
      endTime ? parseInt(endTime, 10) : undefined,
    );
  }

  @Get('history')
  @ApiOperation({ summary: 'Get connection history for a specific client', description: 'Retrieve historical connection data for a specific client identified by name, user, or address' })
  @ApiQuery({ name: 'name', required: false, description: 'Filter by client name' })
  @ApiQuery({ name: 'user', required: false, description: 'Filter by authenticated username' })
  @ApiQuery({ name: 'addr', required: false, description: 'Filter by client address' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Filter by start timestamp (Unix milliseconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'Filter by end timestamp (Unix milliseconds)' })
  @ApiResponse({ status: 200, description: 'Connection history retrieved successfully', type: [StoredClientSnapshotDto] })
  @ApiResponse({ status: 400, description: 'Must provide name, user, or addr' })
  @ApiResponse({ status: 500, description: 'Failed to get connection history' })
  async getConnectionHistory(
    @Query('name') name?: string,
    @Query('user') user?: string,
    @Query('addr') addr?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<StoredClientSnapshot[]> {
    if (!name && !user && !addr) {
      throw new HttpException('Must provide name, user, or addr', HttpStatus.BAD_REQUEST);
    }
    return this.service.getConnectionHistory(
      { name, user, addr },
      startTime ? parseInt(startTime, 10) : undefined,
      endTime ? parseInt(endTime, 10) : undefined,
    );
  }

  @Delete('cleanup')
  @ApiOperation({ summary: 'Trigger manual cleanup', description: 'Manually trigger cleanup of old client snapshot data' })
  @ApiResponse({ status: 200, description: 'Cleanup completed successfully', type: CleanupResponseDto })
  @ApiResponse({ status: 500, description: 'Failed to cleanup' })
  async cleanup(): Promise<{ pruned: number }> {
    const pruned = await this.service.cleanup();
    return { pruned };
  }
}
