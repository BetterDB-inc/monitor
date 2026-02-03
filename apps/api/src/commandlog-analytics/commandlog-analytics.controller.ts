import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { CommandLogAnalyticsService } from './commandlog-analytics.service';
import { StoredCommandLogEntry, CommandLogType } from '../common/interfaces/storage-port.interface';
import { SlowLogPatternAnalysis } from '../common/types/metrics.types';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';

@ApiTags('command-log-analytics')
@Controller('commandlog-analytics')
export class CommandLogAnalyticsController {
  constructor(private readonly commandLogAnalyticsService: CommandLogAnalyticsService) {}

  @Get('entries')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start time filter (Unix timestamp in seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End time filter (Unix timestamp in seconds)' })
  @ApiQuery({ name: 'command', required: false, description: 'Filter by command name' })
  @ApiQuery({ name: 'clientName', required: false, description: 'Filter by client name' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by log type (slow, large-request, large-reply)' })
  @ApiQuery({ name: 'minDuration', required: false, description: 'Minimum duration in microseconds' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return' })
  @ApiQuery({ name: 'offset', required: false, description: 'Offset for pagination' })
  async getStoredCommandLog(
    @ConnectionId() connectionId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('command') command?: string,
    @Query('clientName') clientName?: string,
    @Query('type') type?: string,
    @Query('minDuration') minDuration?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredCommandLogEntry[]> {
    return this.commandLogAnalyticsService.getStoredCommandLog({
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      command,
      clientName,
      type: type as CommandLogType | undefined,
      minDuration: minDuration ? parseInt(minDuration, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
      connectionId,
    });
  }

  @Get('patterns')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start time filter (Unix timestamp in seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End time filter (Unix timestamp in seconds)' })
  @ApiQuery({ name: 'type', required: false, description: 'Filter by log type (slow, large-request, large-reply)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to analyze' })
  async getStoredCommandLogPatternAnalysis(
    @ConnectionId() connectionId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ): Promise<SlowLogPatternAnalysis> {
    return this.commandLogAnalyticsService.getStoredCommandLogPatternAnalysis({
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      type: type as CommandLogType | undefined,
      limit: limit ? parseInt(limit, 10) : 500,
      connectionId,
    });
  }
}
