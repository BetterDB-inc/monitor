import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Feature, InferenceLatencyProfile, InferenceLatencyTrend } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
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
  @UseGuards(LicenseGuard)
  @RequiresFeature(Feature.INFERENCE_SLA)
  @ApiOperation({
    summary: 'Historical inference latency trend (Pro)',
    description:
      'Bucketed percentile history for one bucket, computed on-read from the raw latency ' +
      'source. Pro-only: returns 402 via LicenseGuard when the active license does not ' +
      'include the inference SLA feature.',
  })
  @ApiQuery({ name: 'bucket', required: true, example: 'FT.SEARCH:idx_cache' })
  @ApiQuery({ name: 'startTime', required: true, type: Number })
  @ApiQuery({ name: 'endTime', required: true, type: Number })
  @ApiQuery({ name: 'bucketMs', required: false, type: Number, example: 60000 })
  @ApiHeader({ name: 'x-connection-id', required: false })
  async getTrend(
    @Query('bucket') bucket: string | undefined,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
    @Query('bucketMs') bucketMs?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<InferenceLatencyTrend> {
    if (!bucket) throw new BadRequestException('bucket query parameter is required');
    if (!startTime) throw new BadRequestException('startTime query parameter is required');
    if (!endTime) throw new BadRequestException('endTime query parameter is required');

    const startMs = Number(startTime);
    const endMs = Number(endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new BadRequestException('startTime and endTime must be numeric');
    }
    const parsedBucketMs = bucketMs ? Number(bucketMs) : undefined;
    if (parsedBucketMs !== undefined && (!Number.isFinite(parsedBucketMs) || parsedBucketMs <= 0)) {
      throw new BadRequestException('bucketMs must be a positive number');
    }

    const resolvedId = this.requireConnectionId(connectionId);
    try {
      return await this.service.getTrend(resolvedId, bucket, startMs, endMs, parsedBucketMs);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
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
