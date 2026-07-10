import { Controller, Get, Param, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import type { StoredAiCacheSample } from '@betterdb/shared';
import { ConnectionId } from '../common/decorators';
import { AiObservabilityService, AiInstanceWithSample } from './ai-observability.service';

@ApiTags('ai-observability')
@Controller('ai')
export class AiObservabilityController {
  constructor(private readonly service: AiObservabilityService) {}

  @Get('instances')
  @ApiOperation({
    summary: 'List discovered AI cache/memory instances with their latest sample',
  })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getInstances(
    @ConnectionId() connectionId?: string,
  ): Promise<{ instances: AiInstanceWithSample[] }> {
    try {
      const instances = await this.service.getInstances(connectionId);
      return { instances };
    } catch (error) {
      throw this.mapError(error, 'Failed to list AI instances');
    }
  }

  @Get('instances/:field/history')
  @ApiOperation({ summary: 'Time-series history for a single AI instance' })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async getHistory(
    @Param('field') field: string,
    @Query('hours') hours?: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ samples: StoredAiCacheSample[] }> {
    try {
      const parsed = hours ? parseInt(hours, 10) : 24;
      const windowHours = Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
      const samples = await this.service.getHistory(connectionId, field, windowHours);
      return { samples };
    } catch (error) {
      throw this.mapError(error, 'Failed to get AI instance history');
    }
  }

  private mapError(error: unknown, fallback: string): HttpException {
    if (error instanceof HttpException) return error;
    const msg = error instanceof Error ? error.message : 'Unknown error';
    const status =
      msg.includes('not available') || msg.includes('not supported')
        ? HttpStatus.NOT_IMPLEMENTED
        : HttpStatus.INTERNAL_SERVER_ERROR;
    return new HttpException(`${fallback}: ${msg}`, status);
  }
}
