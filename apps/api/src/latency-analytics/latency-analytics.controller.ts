import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { LatencyAnalyticsService } from './latency-analytics.service';
import { StoredLatencySnapshot } from '../common/interfaces/storage-port.interface';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';

@ApiTags('latency-analytics')
@Controller('latency-analytics')
export class LatencyAnalyticsController {
  constructor(private readonly latencyAnalyticsService: LatencyAnalyticsService) {}

  @Get('snapshots')
  @ApiHeader({ name: CONNECTION_ID_HEADER, required: false, description: 'Connection ID to filter by' })
  @ApiQuery({ name: 'startTime', required: false, description: 'Start time filter (ms since epoch)' })
  @ApiQuery({ name: 'endTime', required: false, description: 'End time filter (ms since epoch)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Maximum number of entries to return' })
  @ApiQuery({ name: 'offset', required: false, description: 'Offset for pagination' })
  async getSnapshots(
    @ConnectionId() connectionId?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<StoredLatencySnapshot[]> {
    return this.latencyAnalyticsService.getStoredSnapshots({
      startTime: startTime ? parseInt(startTime, 10) : undefined,
      endTime: endTime ? parseInt(endTime, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : 100,
      offset: offset ? parseInt(offset, 10) : 0,
      connectionId,
    });
  }
}
