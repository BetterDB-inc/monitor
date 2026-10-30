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
import { ValidateInstanceIdPipe, mapMcpError, safeLimit, safeParseInt } from '@app/mcp/mcp-helpers';
import { AnomalyService } from './anomaly.service';
import { MetricType } from './types';

const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DIVERGENCE_SERIES_LOOKBACK_MS = 60 * 60 * 1000;
const METRIC_TYPE_VALUES = new Set<string>(Object.values(MetricType));

@Controller('mcp')
@UseGuards(AgentTokenGuard, LicenseGuard)
@RequiresFeature(Feature.ANOMALY_DETECTION)
export class McpAnomalyController {
  private readonly logger = new Logger(McpAnomalyController.name);

  constructor(private readonly anomalyService: AnomalyService) {}

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

  @Get('instance/:id/history/incidents')
  async getIncidents(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
  ) {
    try {
      return await this.anomalyService.getIncidentTimelines(
        id,
        safeParseInt(startTime, Date.now() - DEFAULT_LOOKBACK_MS),
        undefined,
        safeLimit(limit, 20),
      );
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get incident timelines');
    }
  }

  @Get('instance/:id/history/replication-divergence')
  async getReplicationDivergence(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('limit') limit?: string,
    @Query('startTime') startTime?: string,
  ) {
    const now = Date.now();
    try {
      const [replicas, events] = await Promise.all([
        this.anomalyService.getReplicationDivergenceHistory(
          id,
          safeParseInt(startTime, now - DIVERGENCE_SERIES_LOOKBACK_MS),
          now,
        ),
        this.anomalyService
          .getRecentAnomalies(
            safeParseInt(startTime, now - DEFAULT_LOOKBACK_MS),
            undefined,
            undefined,
            MetricType.REPLICATION_DIVERGENCE,
            safeLimit(limit, 100),
            id,
          )
          .catch((error) => {
            this.logger.warn(
              `Failed to read divergence events: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }),
      ]);
      return events ? { replicas, events } : { replicas, events: [], eventsUnavailable: true };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get replication divergence');
    }
  }
}
