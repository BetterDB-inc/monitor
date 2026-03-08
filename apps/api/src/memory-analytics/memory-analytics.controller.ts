import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiQuery, ApiHeader } from '@nestjs/swagger';
import { MemoryAnalyticsService } from './memory-analytics.service';
import { StoredMemorySnapshot } from '../common/interfaces/storage-port.interface';
import { ConnectionId, CONNECTION_ID_HEADER } from '../common/decorators';

function parseOptionalInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) throw new BadRequestException(`${name} must be a valid integer`);
  return parsed;
}

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
