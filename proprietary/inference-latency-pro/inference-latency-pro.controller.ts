import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Feature, InferenceLatencyTrend } from '@betterdb/shared';
import { LicenseGuard } from '@proprietary/licenses';
import { RequiresFeature } from '@proprietary/licenses/requires-feature.decorator';
import { ConnectionId } from '@app/common/decorators';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { requireConnectionId } from '@app/connections/require-connection-id';
import {
  InferenceLatencyService,
  InferenceLatencyValidationError,
} from '@app/inference-latency/inference-latency.service';

@ApiTags('inference-latency')
@Controller('inference-latency')
export class InferenceLatencyProController {
  constructor(
    private readonly service: InferenceLatencyService,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

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
    if (!bucket) {
      throw new BadRequestException('bucket query parameter is required');
    }
    if (!startTime) {
      throw new BadRequestException('startTime query parameter is required');
    }
    if (!endTime) {
      throw new BadRequestException('endTime query parameter is required');
    }

    const startMs = Number(startTime);
    const endMs = Number(endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new BadRequestException('startTime and endTime must be numeric');
    }
    const parsedBucketMs = bucketMs ? Number(bucketMs) : undefined;
    if (parsedBucketMs !== undefined && (!Number.isFinite(parsedBucketMs) || parsedBucketMs <= 0)) {
      throw new BadRequestException('bucketMs must be a positive number');
    }

    const resolvedId = requireConnectionId(this.connectionRegistry, connectionId);
    try {
      return await this.service.getTrend(resolvedId, bucket, startMs, endMs, parsedBucketMs);
    } catch (err) {
      if (err instanceof InferenceLatencyValidationError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }
}
