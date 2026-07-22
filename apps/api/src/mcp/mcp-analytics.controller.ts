import { Controller, Get, Logger, Param, UseGuards } from '@nestjs/common';
import { MetricKind } from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { ValidateInstanceIdPipe, mapMcpError } from './mcp-helpers';
import { MetricForecastingService } from '../metric-forecasting/metric-forecasting.service';
import { VectorSearchService } from '../vector-search/vector-search.service';
import { MetricKindValidationPipe } from '../metric-forecasting/pipes/metric-kind-validation.pipe';

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpAnalyticsController {
  private readonly logger = new Logger(McpAnalyticsController.name);

  constructor(
    private readonly vectorSearchService: VectorSearchService,
    private readonly metricForecastingService: MetricForecastingService,
  ) {}

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

  @Get('instance/:id/vector-indexes')
  async getVectorIndexes(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const names = await this.vectorSearchService.getIndexList(id);
      const indexes = await Promise.all(
        names.map((name) => {
          return this.vectorSearchService.getIndexInfo(id, name);
        }),
      );
      return { indexes };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get vector indexes');
    }
  }
}
