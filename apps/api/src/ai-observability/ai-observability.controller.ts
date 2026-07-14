import { Controller, Get, Param, Query, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import type {
  StoredAiCacheSample,
  OtelTraceSummary,
  StoredOtelSpan,
  SpanCorrelation,
} from '@betterdb/shared';
import { ConnectionId } from '../common/decorators';
import { AiObservabilityService, AiInstanceWithSample } from './ai-observability.service';
import { TraceCorrelationService } from './trace-correlation.service';

@ApiTags('ai-observability')
@Controller('ai')
export class AiObservabilityController {
  constructor(
    private readonly service: AiObservabilityService,
    private readonly correlation: TraceCorrelationService,
  ) {}

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
      // Clamp to [1, 168h] like vector-search history: an unbounded value would
      // inflate getHistory's row limit (scaled by window / poll interval).
      const windowHours =
        Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 168) : 24;
      const samples = await this.service.getHistory(connectionId, field, windowHours);
      return { samples };
    } catch (error) {
      throw this.mapError(error, 'Failed to get AI instance history');
    }
  }

  @Get('traces')
  @ApiOperation({ summary: 'Recent ingested traces (OTLP) with per-trace summary' })
  async getTraces(
    @Query('hours') hours?: string,
    @Query('service') service?: string,
    @Query('limit') limit?: string,
  ): Promise<{ traces: OtelTraceSummary[] }> {
    try {
      // Clamp both bounds like the history endpoint: an unbounded window or limit
      // could force heavy aggregation over the whole otel_spans table.
      const h = hours ? parseInt(hours, 10) : 1;
      const l = limit ? parseInt(limit, 10) : 100;
      const traces = await this.service.getTraces(
        Number.isFinite(h) && h > 0 ? Math.min(h, 168) : 1,
        service || undefined,
        Number.isFinite(l) && l > 0 ? Math.min(l, 1000) : 100,
      );
      return { traces };
    } catch (error) {
      throw this.mapError(error, 'Failed to list traces');
    }
  }

  @Get('traces/:traceId')
  @ApiOperation({ summary: 'All stored spans for one trace (waterfall)' })
  async getTraceSpans(
    @Param('traceId') traceId: string,
  ): Promise<{ spans: StoredOtelSpan[] }> {
    try {
      const spans = await this.service.getTraceSpans(traceId);
      return { spans };
    } catch (error) {
      throw this.mapError(error, 'Failed to get trace spans');
    }
  }

  @Get('traces/:traceId/correlate')
  @ApiOperation({
    summary: 'Correlate a trace\'s BetterDB spans with live Valkey state (key TTL, threshold, index)',
  })
  @ApiHeader({ name: 'x-connection-id', required: false, description: 'Connection ID to target' })
  async correlateTrace(
    @Param('traceId') traceId: string,
    @ConnectionId() connectionId?: string,
  ): Promise<{ correlations: SpanCorrelation[] }> {
    try {
      const correlations = await this.correlation.correlateTrace(traceId, connectionId);
      return { correlations };
    } catch (error) {
      throw this.mapError(error, 'Failed to correlate trace');
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
