import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Query,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InferenceLatencyProfile } from '@betterdb/shared';
import { ConnectionId } from '../common/decorators';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { InferenceLatencyService } from './inference-latency.service';

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
    description: 'Window length in milliseconds (default 15 minutes).',
    example: 900000,
  })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getProfile(
    @Query('windowMs') windowMs?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<InferenceLatencyProfile> {
    const resolvedId = this.requireConnectionId(connectionId);
    const parsedWindow = windowMs ? Number(windowMs) : undefined;
    return this.service.getProfile(resolvedId, parsedWindow);
  }

  @Get('trend')
  @ApiOperation({
    summary: 'Historical inference latency trend (Pro)',
    description:
      'Time-series bucketed percentile history for one bucket. Pro-only. Returns 402 ' +
      'when the active license does not include the inference SLA feature.',
  })
  getTrend(): never {
    throw new HttpException(
      'Inference latency trend history requires a Pro license.',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  private requireConnectionId(requestedId: string | undefined): string {
    if (requestedId) {
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
