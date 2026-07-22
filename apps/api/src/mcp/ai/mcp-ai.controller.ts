import { Controller, Get, Logger, Param, Query, UseGuards } from '@nestjs/common';
import { AgentTokenGuard } from '../../common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError, safeLimit, safeParseInt } from '../mcp-helpers';
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
      const samples = await this.aiObservability.getHistory(id, field, safeParseInt(hours, 24));
      return { samples };
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
        safeParseInt(hours, 1),
        hasService === true ? service : undefined,
        safeLimit(limit, 100),
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
