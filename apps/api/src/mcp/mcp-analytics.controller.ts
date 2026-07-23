import { Controller, Get, Logger, Param, UseGuards } from '@nestjs/common';
import { MetricKind } from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError } from './mcp-helpers';
import { MetricForecastingService } from '../metric-forecasting/metric-forecasting.service';
import { MetricKindValidationPipe } from '../metric-forecasting/pipes/metric-kind-validation.pipe';

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpAnalyticsController {
  private readonly logger = new Logger(McpAnalyticsController.name);

  constructor(private readonly metricForecastingService: MetricForecastingService) {}

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
