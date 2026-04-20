import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConnectionId } from '../common/decorators';
import {
  CommandStatsHistoryQueryOptions,
  StoragePort,
  StoredCommandStatsSample,
} from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  CommandstatsPollerService,
  CommandStatsSnapshotEntry,
} from './commandstats-poller.service';

@ApiTags('metrics')
@Controller('metrics/commandstats')
export class CommandstatsController {
  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly poller: CommandstatsPollerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Get the current commandstats snapshot',
    description: `Returns the most recent absolute per-command counters (calls, usec, usec_per_call, 
rejected_calls, failed_calls) as captured by the last poll. Empty until the first  
successful poll completes for the connection.`,
  })
  @ApiHeader({ name: 'x-connection-id', required: false })
  getSnapshot(@ConnectionId() connectionId?: string): CommandStatsSnapshotEntry[] {
    const resolvedId = connectionId ?? this.connectionRegistry.getDefaultId();
    if (!resolvedId) return [];
    return this.poller.getSnapshot(resolvedId);
  }

  @Get(':command/history')
  @ApiOperation({
    summary: 'Get commandstats delta samples for a single command',
    description: `Returns per-sample deltas (calls, usec) since the previous poll so clients 
can derive ops/sec and average latency time-series without cumulative offset.`,
  })
  @ApiParam({ name: 'command', example: 'ft.search', description: 'Case-insensitive command name' })
  @ApiHeader({ name: 'x-connection-id', required: false })
  @ApiQuery({
    name: 'from',
    required: false,
    type: Number,
    description:
      'Start of the query window as a Unix timestamp in milliseconds. Defaults to now minus 24 hours.',
    example: 1700000000000,
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: Number,
    description: 'End of the query window as a Unix timestamp in milliseconds. Defaults to now.',
    example: 1700000600000,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description:
      'Maximum number of samples to return (oldest-first within the window). Storage adapters enforce their own 10,000-sample cap when omitted.',
    example: 500,
  })
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
    const defaultWindowMs = 24 * 60 * 60 * 1000; // 24 hours
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
