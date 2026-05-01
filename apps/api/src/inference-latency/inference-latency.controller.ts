import {
  BadRequestException,
  Controller,
  Get,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InferenceLatencyProfile } from '@betterdb/shared';
import { ConnectionId } from '../common/decorators';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { requireConnectionId } from '../connections/require-connection-id';
import {
  InferenceLatencyService,
  InferenceLatencyValidationError,
} from './inference-latency.service';

@ApiTags('inference-latency')
@Controller('inference-latency')
export class InferenceLatencyController {
  constructor(
    private readonly service: InferenceLatencyService,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  @Get('profile')
  @ApiOperation({
    summary: 'Current inference latency profile',
    description:
      'Returns per-bucket p50/p95/p99 for FT.SEARCH:<index>, read, and write buckets over ' +
      'the requested window. Source is chosen by capability: command_log_entries on Valkey ' +
      '8.1+, slowlog_entries elsewhere. Exposes the active threshold directive + value so ' +
      'callers can qualify the percentiles (threshold-gated source tables skew toward the tail).',
  })
  @ApiQuery({
    name: 'windowMs',
    required: false,
    type: Number,
    description:
      'Rolling window length in ms (default 15 minutes). Ignored when startTime and endTime are both supplied.',
    example: 900000,
  })
  @ApiQuery({
    name: 'startTime',
    required: false,
    type: Number,
    description:
      'Explicit window start (Unix ms). Must be supplied together with endTime. Takes precedence over windowMs.',
  })
  @ApiQuery({
    name: 'endTime',
    required: false,
    type: Number,
    description: 'Explicit window end (Unix ms). Must be supplied together with startTime.',
  })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getProfile(
    @Query('windowMs') windowMs?: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<InferenceLatencyProfile> {
    const resolvedId = requireConnectionId(this.connectionRegistry, connectionId);

    const hasStart = startTime !== undefined && startTime !== '';
    const hasEnd = endTime !== undefined && endTime !== '';
    if (hasStart !== hasEnd) {
      throw new BadRequestException('startTime and endTime must be supplied together');
    }

    const parsedStart = hasStart ? Number(startTime) : undefined;
    const parsedEnd = hasEnd ? Number(endTime) : undefined;
    if (
      (parsedStart !== undefined && !Number.isFinite(parsedStart)) ||
      (parsedEnd !== undefined && !Number.isFinite(parsedEnd))
    ) {
      throw new BadRequestException('startTime and endTime must be numeric');
    }

    const parsedWindow = windowMs ? Number(windowMs) : undefined;
    if (parsedWindow !== undefined && !Number.isFinite(parsedWindow)) {
      throw new BadRequestException('windowMs must be numeric');
    }

    try {
      return await this.service.getProfile(resolvedId, {
        windowMs: parsedWindow,
        startTime: parsedStart,
        endTime: parsedEnd,
      });
    } catch (err) {
      if (err instanceof InferenceLatencyValidationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
