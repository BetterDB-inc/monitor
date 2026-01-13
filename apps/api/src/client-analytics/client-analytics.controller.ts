import { Controller, Get, Delete, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ClientAnalyticsService } from './client-analytics.service';
import { ClientAnalyticsAnalysisService } from './client-analytics-analysis.service';
import {
  StoredClientSnapshot,
  ClientTimeSeriesPoint,
  ClientAnalyticsStats,
  CommandDistributionParams,
  CommandDistributionResponse,
  IdleConnectionsParams,
  IdleConnectionsResponse,
  BufferAnomaliesParams,
  BufferAnomaliesResponse,
  ActivityTimelineParams,
  ActivityTimelineResponse,
  SpikeDetectionParams,
  SpikeDetectionResponse,
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
  constructor(
    private service: ClientAnalyticsService,
    private analysisService: ClientAnalyticsAnalysisService,
  ) {}

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

  @Get('command-distribution')
  @ApiOperation({ summary: 'Get command distribution analysis', description: 'Returns command frequency distribution over a time range, grouped by client' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start timestamp (Unix milliseconds), default: 1 hour ago' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End timestamp (Unix milliseconds), default: now' })
  @ApiQuery({ name: 'groupBy', required: false, description: 'Group by: client_name | user | addr, default: client_name' })
  @ApiResponse({ status: 200, description: 'Command distribution retrieved successfully' })
  @ApiResponse({ status: 500, description: 'Failed to get command distribution' })
  async getCommandDistribution(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('groupBy') groupBy?: 'client_name' | 'user' | 'addr',
  ): Promise<CommandDistributionResponse> {
    const params: CommandDistributionParams = {
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      groupBy,
    };
    return this.analysisService.getCommandDistribution(params);
  }

  @Get('idle-connections')
  @ApiOperation({ summary: 'Get idle connections', description: 'Identifies connections that have been idle for extended periods' })
  @ApiQuery({ name: 'idleThresholdSeconds', required: false, description: 'Idle threshold in seconds, default: 300 (5 min)' })
  @ApiQuery({ name: 'minOccurrences', required: false, description: 'Minimum occurrences, default: 10' })
  @ApiResponse({ status: 200, description: 'Idle connections retrieved successfully' })
  @ApiResponse({ status: 500, description: 'Failed to get idle connections' })
  async getIdleConnections(
    @Query('idleThresholdSeconds') idleThresholdSeconds?: string,
    @Query('minOccurrences') minOccurrences?: string,
  ): Promise<IdleConnectionsResponse> {
    const params: IdleConnectionsParams = {
      idleThresholdSeconds: idleThresholdSeconds ? parseInt(idleThresholdSeconds, 10) : undefined,
      minOccurrences: minOccurrences ? parseInt(minOccurrences, 10) : undefined,
    };
    return this.analysisService.getIdleConnections(params);
  }

  @Get('buffer-anomalies')
  @ApiOperation({ summary: 'Get buffer anomalies', description: 'Detects clients with unusual buffer sizes that may indicate problematic queries' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start timestamp (Unix milliseconds), default: 1 hour ago' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End timestamp (Unix milliseconds), default: now' })
  @ApiQuery({ name: 'qbufThreshold', required: false, description: 'Input buffer threshold in bytes, default: 1MB' })
  @ApiQuery({ name: 'omemThreshold', required: false, description: 'Output buffer threshold in bytes, default: 10MB' })
  @ApiResponse({ status: 200, description: 'Buffer anomalies retrieved successfully' })
  @ApiResponse({ status: 500, description: 'Failed to get buffer anomalies' })
  async getBufferAnomalies(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('qbufThreshold') qbufThreshold?: string,
    @Query('omemThreshold') omemThreshold?: string,
  ): Promise<BufferAnomaliesResponse> {
    const params: BufferAnomaliesParams = {
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      qbufThreshold: qbufThreshold ? parseInt(qbufThreshold, 10) : undefined,
      omemThreshold: omemThreshold ? parseInt(omemThreshold, 10) : undefined,
    };
    return this.analysisService.getBufferAnomalies(params);
  }

  @Get('activity-timeline')
  @ApiOperation({ summary: 'Get activity timeline', description: 'Returns activity over time for correlation with other metrics' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start timestamp (Unix milliseconds), default: 1 hour ago' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End timestamp (Unix milliseconds), default: now' })
  @ApiQuery({ name: 'bucketSizeMinutes', required: false, description: 'Bucket size in minutes, default: 5' })
  @ApiQuery({ name: 'client', required: false, description: 'Optional filter by client name' })
  @ApiResponse({ status: 200, description: 'Activity timeline retrieved successfully' })
  @ApiResponse({ status: 500, description: 'Failed to get activity timeline' })
  async getActivityTimeline(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('bucketSizeMinutes') bucketSizeMinutes?: string,
    @Query('client') client?: string,
  ): Promise<ActivityTimelineResponse> {
    const params: ActivityTimelineParams = {
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      bucketSizeMinutes: bucketSizeMinutes ? parseInt(bucketSizeMinutes, 10) : undefined,
      client,
    };
    return this.analysisService.getActivityTimeline(params);
  }

  @Get('spike-detection')
  @ApiOperation({ summary: 'Detect activity spikes', description: 'Automatically detects unusual activity spikes' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start timestamp (Unix milliseconds), default: 24 hours ago' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End timestamp (Unix milliseconds), default: now' })
  @ApiQuery({ name: 'sensitivityMultiplier', required: false, description: 'Sensitivity multiplier (std dev), default: 2' })
  @ApiResponse({ status: 200, description: 'Spike detection completed successfully' })
  @ApiResponse({ status: 500, description: 'Failed to detect spikes' })
  async detectSpikes(
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('sensitivityMultiplier') sensitivityMultiplier?: string,
  ): Promise<SpikeDetectionResponse> {
    const params: SpikeDetectionParams = {
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      sensitivityMultiplier: sensitivityMultiplier ? parseFloat(sensitivityMultiplier) : undefined,
    };
    return this.analysisService.detectSpikes(params);
  }
}
