import { Controller, Get, Inject, Logger, Optional, Param, Query, UseGuards } from '@nestjs/common';
import { ANOMALY_SERVICE, MetricKind } from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError, safeLimit, safeParseInt } from './mcp-helpers';
import { MetricForecastingService } from '../metric-forecasting/metric-forecasting.service';
import { MetricKindValidationPipe } from '../metric-forecasting/pipes/metric-kind-validation.pipe';

export const LATENCY_REGRESSION_METRIC_TYPE = 'command_p99';

interface AnomalyQueryService {
  getRecentAnomalies(
    startTime?: number,
    endTime?: number,
    severity?: string,
    metricType?: string,
    limit?: number,
    connectionId?: string,
  ): Promise<unknown[]>;
}

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpAnalyticsController {
  private readonly logger = new Logger(McpAnalyticsController.name);
  private readonly anomalyService: AnomalyQueryService | null;

  constructor(
    private readonly metricForecastingService: MetricForecastingService,
    @Optional() @Inject(ANOMALY_SERVICE) anomalyService?: AnomalyQueryService,
  ) {
    this.anomalyService = anomalyService ?? null;
  }

  @Get('instance/:id/forecast/:metricKind')
  async getForecast(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Param('metricKind', MetricKindValidationPipe) metricKind: MetricKind,
  ) {
    try {
      return await this.metricForecastingService.getForecast(id, metricKind);
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get forecast');
    }
  }

  @Get('instance/:id/history/latency-regressions')
  async getLatencyRegressions(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
  ) {
    if (this.anomalyService === null) {
      return {
        events: [],
        note: 'Latency regression detection is not available (requires BetterDB Pro)',
      };
    }
    try {
      const events = await this.anomalyService.getRecentAnomalies(
        safeParseInt(startTime, Date.now() - 24 * 60 * 60 * 1000),
        undefined,
        undefined,
        LATENCY_REGRESSION_METRIC_TYPE,
        safeLimit(limit, 100),
        id,
      );
      return { events };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get latency regressions');
    }
  }
}
