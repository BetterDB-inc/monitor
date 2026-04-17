import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { ConnectionId } from '../common/decorators';
import {
  CommandStatsHistoryQueryOptions,
  StoragePort,
  StoredCommandStatsSample,
} from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';

@ApiTags('metrics')
@Controller('metrics/commandstats')
export class CommandstatsController {
  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  @Get(':command/history')
  @ApiOperation({
    summary: 'Get commandstats delta samples for a single command',
    description:
      'Returns per-sample deltas (calls, usec) since the previous poll so clients ' +
      'can derive ops/sec and average latency time-series without cumulative offset.',
  })
  @ApiParam({ name: 'command', example: 'ft.search', description: 'Case-insensitive command name' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getHistory(
    @Param('command') command: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<StoredCommandStatsSample[]> {
    const resolvedId = connectionId ?? this.connectionRegistry.getDefaultId();
    if (!resolvedId) return [];

    const now = Date.now();
    const defaultWindowMs = 24 * 60 * 60 * 1000;
    const options: CommandStatsHistoryQueryOptions = {
      connectionId: resolvedId,
      command: command.toLowerCase(),
      startTime: from ? Number(from) : now - defaultWindowMs,
      endTime: to ? Number(to) : now,
      limit: limit ? Number(limit) : undefined,
    };

    return this.storage.getCommandStatsHistory(options);
  }
}
