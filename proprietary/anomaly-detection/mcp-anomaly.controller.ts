import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LicenseGuard, RequiresFeature, Feature } from '@proprietary/licenses';
import { AgentTokenGuard } from '@app/common/guards/agent-token.guard';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { ValidateInstanceIdPipe, mapMcpError, safeLimit, safeParseInt } from '@app/mcp/mcp-helpers';
import { AnomalyService } from './anomaly.service';
import { MetricType } from './types';

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const METRIC_TYPE_VALUES = new Set<string>(Object.values(MetricType));

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.ANOMALY_DETECTION)
export class McpAnomalyController {
  private readonly logger = new Logger(McpAnomalyController.name);

  constructor(
    private readonly anomalyService: AnomalyService,
    private readonly registry: ConnectionRegistry,
  ) {}

  @Get('instance/:id/history/anomalies')
  async getAnomalies(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('metricType') metricType?: string,
    @Query('startTime') startTime?: string,
  ) {
    const hasMetricType = metricType !== undefined && metricType !== '';
    if (hasMetricType === true && METRIC_TYPE_VALUES.has(metricType) === false) {
      throw new BadRequestException(`Unknown metricType: ${metricType}`);
    }
    try {
      return await this.anomalyService.getRecentAnomalies(
        safeParseInt(startTime, Date.now() - DEFAULT_LOOKBACK_MS),
        undefined,
        undefined,
        hasMetricType === true ? (metricType as MetricType) : undefined,
        safeLimit(limit, 100),
        id,
      );
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get anomalies');
    }
  }

  @Get('instance/:id/anomalies/retry-amplification')
  getRetryAmplification(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      this.registry.get(id);
      return this.anomalyService.getRetryAmplificationStatus(id);
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get retry amplification status');
    }
  }
}
