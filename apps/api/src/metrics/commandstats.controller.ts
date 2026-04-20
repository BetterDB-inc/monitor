import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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

  @Get('summary')
  @ApiOperation({
    summary: 'Get the current per-command commandstats snapshot',
    description:
      'Returns the most recent absolute per-command counters (calls, usec, usec_per_call, ' +
      'rejected_calls, failed_calls) from the last poll, aggregated one row per command. ' +
      'Empty until the first successful poll completes for the connection. ' +
      'Pass an explicit x-connection-id header to target a non-default connection; ' +
      'unknown ids return 404.',
  })
  @ApiHeader({ name: 'x-connection-id', required: false })
  getSummary(@ConnectionId() connectionId?: string): CommandStatsSnapshotEntry[] {
    const resolvedId = this.requireConnectionId(connectionId);
    return this.poller.getSnapshot(resolvedId);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get commandstats delta samples for a single command',
    description:
      'Returns per-sample deltas (calls, usec) since the previous poll so clients can derive ' +
      'ops/sec and average latency time-series without cumulative offset. Time range defaults ' +
      'to the last hour. Pass an explicit x-connection-id header to target a non-default ' +
      'connection; unknown ids return 404.',
  })
  @ApiQuery({
    name: 'command',
    required: true,
    description: 'Case-insensitive command name — e.g. ft.search, json.get, get',
    example: 'ft.search',
  })
  @ApiQuery({
    name: 'startTime',
    required: false,
    type: Number,
    description: 'Start of the window as a Unix timestamp in milliseconds. Defaults to now minus 1 hour.',
    example: 1700000000000,
  })
  @ApiQuery({
    name: 'endTime',
    required: false,
    type: Number,
    description: 'End of the window as a Unix timestamp in milliseconds. Defaults to now.',
    example: 1700003600000,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description:
      'Maximum number of samples to return (oldest-first within the window). Storage adapters enforce their own 10,000-sample cap when omitted.',
    example: 500,
  })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getHistory(
    @Query('command') command: string | undefined,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<StoredCommandStatsSample[]> {
    if (!command) {
      throw new BadRequestException('command query parameter is required');
    }

    const resolvedId = this.requireConnectionId(connectionId);

    const now = Date.now();
    const defaultWindowMs = 60 * 60 * 1000; // 1 hour
    const options: CommandStatsHistoryQueryOptions = {
      connectionId: resolvedId,
      command: command.toLowerCase(),
      startTime: startTime ? Number(startTime) : now - defaultWindowMs,
      endTime: endTime ? Number(endTime) : now,
      limit: limit ? Number(limit) : undefined,
    };

    return this.storage.getCommandStatsHistory(options);
  }

  private requireConnectionId(requestedId: string | undefined): string {
    if (requestedId) {
      // Throws NotFoundException (404) if the id is not registered.
      this.connectionRegistry.get(requestedId);
      return requestedId;
    }
    const defaultId = this.connectionRegistry.getDefaultId();
    if (!defaultId) {
      throw new NotFoundException(
        'No connection available. Pass x-connection-id header or configure a default connection.',
      );
    }
    return defaultId;
  }
}
