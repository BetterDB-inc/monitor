import { Controller, Get, Inject, Logger, Optional, Param, UseGuards } from '@nestjs/common';
import { ANOMALY_SERVICE, MetricKind } from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError } from './mcp-helpers';
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
}
