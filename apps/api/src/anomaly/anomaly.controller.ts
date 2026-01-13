import { Controller, Get, Post, Query, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { AnomalyService } from './anomaly.service';
import {
  AnomalyEvent,
  CorrelatedAnomalyGroup,
  BufferStats,
  AnomalySummary,
  MetricType,
  AnomalyPattern,
} from './types';

@Controller('anomaly')
export class AnomalyController {
  constructor(private readonly anomalyService: AnomalyService) {}

  @Get('events')
  getEvents(
    @Query('limit') limit?: string,
    @Query('metricType') metricType?: MetricType,
  ): AnomalyEvent[] {
    const parsedLimit = limit ? parseInt(limit, 10) : 100;
    return this.anomalyService.getRecentEvents(parsedLimit, metricType);
  }

  @Get('groups')
  getGroups(
    @Query('limit') limit?: string,
    @Query('pattern') pattern?: AnomalyPattern,
  ): CorrelatedAnomalyGroup[] {
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    return this.anomalyService.getRecentGroups(parsedLimit, pattern);
  }

  @Get('summary')
  getSummary(): AnomalySummary {
    return this.anomalyService.getSummary();
  }

  @Get('buffers')
  getBuffers(): BufferStats[] {
    return this.anomalyService.getBufferStats();
  }

  @Post('events/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolveEvent(@Param('id') id: string): { success: boolean } {
    const success = this.anomalyService.resolveAnomaly(id);
    return { success };
  }

  @Post('groups/:correlationId/resolve')
  @HttpCode(HttpStatus.OK)
  resolveGroup(@Param('correlationId') correlationId: string): { success: boolean } {
    const success = this.anomalyService.resolveGroup(correlationId);
    return { success };
  }

  @Post('events/clear-resolved')
  @HttpCode(HttpStatus.OK)
  clearResolved(): { cleared: number } {
    const cleared = this.anomalyService.clearResolved();
    return { cleared };
  }
}
