import { Controller, Get, Inject, NotFoundException, Query } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConnectionId } from '../common/decorators';
import {
  LatencyStatsHistoryQueryOptions,
  StoragePort,
  StoredLatencyStatsSample,
} from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import {
  LatencystatsPollerService,
  LatencyStatsSnapshotEntry,
} from './latencystats-poller.service';

@ApiTags('metrics')
@Controller('metrics/latencystats')
export class LatencystatsController {
  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    private readonly connectionRegistry: ConnectionRegistry,
    private readonly poller: LatencystatsPollerService,
  ) {}

  @Get('summary')
  @ApiOperation({
    summary: 'Get the current per-command latency percentile snapshot',
    description:
      'Returns the most recent per-command p50/p99/p99.9 latency percentiles (microseconds) ' +
      'from INFO latencystats, including the server version observed in the same poll. ' +
      'Empty until the first successful poll, on servers older than 7.0, or when ' +
      'latency-tracking is disabled. Pass an explicit x-connection-id header to target a ' +
      'non-default connection; unknown ids return 404.',
  })
  @ApiHeader({ name: 'x-connection-id', required: false })
  getSummary(@ConnectionId() connectionId?: string): LatencyStatsSnapshotEntry[] {
    const resolvedId = this.requireConnectionId(connectionId);
    return this.poller.getSnapshot(resolvedId);
  }

  @Get('history')
  @ApiOperation({
    summary: 'Get per-command latency percentile samples over time',
    description:
      'Returns stored latencystats samples (p50/p99/p99.9 in microseconds, cumulative ' +
      't-digest gauges) with the server version captured alongside each sample. Time range ' +
      'defaults to the last hour. Omit the command parameter to return samples for all ' +
      'commands. Pass an explicit x-connection-id header to target a non-default connection; ' +
      'unknown ids return 404.',
  })
  @ApiQuery({
    name: 'command',
    required: false,
    description: 'Case-insensitive command name — e.g. hmget, get, cluster|slots',
    example: 'hmget',
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
    @Query('command') command?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('limit') limit?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<StoredLatencyStatsSample[]> {
    const resolvedId = this.requireConnectionId(connectionId);

    const now = Date.now();
    const defaultWindowMs = 60 * 60 * 1000; // 1 hour
    const options: LatencyStatsHistoryQueryOptions = {
      connectionId: resolvedId,
      command: command ? command.toLowerCase() : undefined,
      startTime: startTime ? Number(startTime) : now - defaultWindowMs,
      endTime: endTime ? Number(endTime) : now,
      limit: limit ? Number(limit) : undefined,
    };

    return this.storage.getLatencyStatsHistory(options);
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
