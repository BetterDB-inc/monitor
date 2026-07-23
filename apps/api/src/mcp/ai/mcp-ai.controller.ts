import { Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError, safeLimit } from '../mcp-helpers';

const MAX_HISTORY_HOURS = 168;
const MAX_TRACE_LIMIT = 1000;
const MAX_HISTORY_POINTS = 200;

function downsample<T>(samples: T[], maxPoints: number): T[] {
  if (samples.length <= maxPoints) {
    return samples;
  }
  const step = samples.length / maxPoints;
  const sampled: T[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    sampled.push(samples[Math.floor(i * step)]);
  }
  sampled.push(samples[samples.length - 1]);
  return sampled;
}
import { AiObservabilityService } from '../../ai-observability/ai-observability.service';
import { TraceCorrelationService } from '../../ai-observability/trace-correlation.service';

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpAiController {
  private readonly logger = new Logger(McpAiController.name);

  constructor(
    private readonly aiObservability: AiObservabilityService,
    private readonly traceCorrelation: TraceCorrelationService,
  ) {}

  @Get('instance/:id/ai/instances')
  async getInstances(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const instances = await this.aiObservability.getInstances(id);
      return { instances };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to list AI instances');
    }
  }

  @Get('instance/:id/ai/instances/:field/history')
  async getHistory(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('field') field: string,
    @Query('hours') hours?: string,
  ) {
    try {
      const samples = await this.aiObservability.getHistory(
        id,
        field,
        safeLimit(hours, 24, MAX_HISTORY_HOURS),
      );
      return { samples: downsample(samples, MAX_HISTORY_POINTS) };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get AI instance history');
    }
  }

  @Get('ai/traces')
  async getTraces(
    @Query('hours') hours?: string,
    @Query('service') service?: string,
    @Query('limit') limit?: string,
  ) {
    try {
      const hasService = service !== undefined && service !== '';
      const traces = await this.aiObservability.getTraces(
        safeLimit(hours, 1, MAX_HISTORY_HOURS),
        hasService === true ? service : undefined,
        safeLimit(limit, 100, MAX_TRACE_LIMIT),
      );
      return { traces };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to list AI traces');
    }
  }

  @Get('ai/traces/:traceId')
  async getTraceSpans(@Param('traceId') traceId: string) {
    try {
      const spans = await this.aiObservability.getTraceSpans(traceId);
      return { spans };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get AI trace');
    }
  }

  @Get('instance/:id/ai/traces/:traceId/correlate')
  async correlateTrace(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('traceId') traceId: string,
  ) {
    try {
      const correlations = await this.traceCorrelation.correlateTrace(traceId, id);
      return { correlations };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to correlate AI trace');
    }
  }
}
