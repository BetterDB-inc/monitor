import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { SlowLogAnalyticsService } from './slowlog-analytics.service';
import { StoredSlowLogEntry } from '../common/interfaces/storage-port.interface';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';

@ApiTags('slow-log-analytics')
@Controller('slowlog-analytics')
export class SlowLogAnalyticsController {
  constructor(private readonly slowLogAnalyticsService: SlowLogAnalyticsService) {}

  @Get('entries')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start time filter (Unix timestamp in seconds)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End time filter (Unix timestamp in seconds)' })
  @ApiQuery({ name: 'command', required: false, description: 'Filter by command name' })
  @ApiQuery({ name: 'clientName', required: false, description: 'Filter by client name' })
  @ApiQuery({ name: 'minDuration', required: false, description: 'Minimum duration in microseconds' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return' })
  @ApiQuery({ name: 'offset', required: false, description: 'Offset for pagination' })
  async getStoredSlowLog(
    @ConnectionId() connectionId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('command') command?: string,
    @Query('clientName') clientName?: string,
    @Query('minDuration') minDuration?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredSlowLogEntry[]> {
    return this.slowLogAnalyticsService.getStoredSlowLog({
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      command,
      clientName,
      minDuration: minDuration ? parseInt(minDuration, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
      connectionId,
    });
  }
}
