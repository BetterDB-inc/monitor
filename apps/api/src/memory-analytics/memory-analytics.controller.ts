import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { MemoryAnalyticsService } from './memory-analytics.service';
import { StoredMemorySnapshot } from '../common/interfaces/storage-port.interface';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';
import { parseOptionalInt } from '../common/utils/parse-query-param';

@ApiTags('memory-analytics')
@Controller('memory-analytics')
export class MemoryAnalyticsController {
  constructor(private readonly memoryAnalyticsService: MemoryAnalyticsService) {}

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
  ): Promise<StoredMemorySnapshot[]> {
    return this.memoryAnalyticsService.getStoredSnapshots({
      startTime: parseOptionalInt(startTime, 'startTime'),
      endTime: parseOptionalInt(endTime, 'endTime'),
      limit: parseOptionalInt(limit, 'limit') ?? 100,
      offset: parseOptionalInt(offset, 'offset') ?? 0,
      connectionId,
    });
  }
}
