import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  INFERENCE_LATENCY_PRO_SERVICE,
  IInferenceLatencyProService,
  MetricKind,
} from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { VectorIndexInfo } from '../common/types/metrics.types';
import { ValidateInstanceIdPipe, mapMcpError } from './mcp-helpers';
import { MetricForecastingService } from '../metric-forecasting/metric-forecasting.service';
import { VectorSearchService } from '../vector-search/vector-search.service';
import { InferenceLatencyService } from '../inference-latency/inference-latency.service';
import { MetricKindValidationPipe } from '../metric-forecasting/pipes/metric-kind-validation.pipe';

@Controller('mcp')
@UseGuards(AgentTokenGuard)
export class McpAnalyticsController {
  private readonly logger = new Logger(McpAnalyticsController.name);
  private readonly inferenceLatencyProService: IInferenceLatencyProService | null;

  constructor(
    private readonly inferenceLatencyService: InferenceLatencyService,
    private readonly vectorSearchService: VectorSearchService,
    private readonly metricForecastingService: MetricForecastingService,
    @Optional()
    @Inject(INFERENCE_LATENCY_PRO_SERVICE)
    inferenceLatencyProService?: IInferenceLatencyProService,
  ) {
    this.inferenceLatencyProService = inferenceLatencyProService ?? null;
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

  @Get('instance/:id/vector-indexes')
  async getVectorIndexes(@Param('id', ValidateInstanceIdPipe) id: string) {
    try {
      const names = await this.vectorSearchService.getIndexList(id);
      const settled = await Promise.allSettled(
        names.map((name) => {
          return this.vectorSearchService.getIndexInfo(id, name);
        }),
      );
      const indexes: VectorIndexInfo[] = [];
      const failedNames: string[] = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          indexes.push(result.value);
          return;
        }
        failedNames.push(names[index]);
      });
      if (names.length > 0 && indexes.length === 0) {
        const failures = settled.filter((result): result is PromiseRejectedResult => {
          return result.status === 'rejected';
        });
        throw failures[0].reason;
      }
      if (failedNames.length > 0) {
        this.logger.warn(`Failed to get info for vector indexes: ${failedNames.join(', ')}`);
      }
      return { indexes };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get vector indexes');
    }
  }

  @Get('instance/:id/inference-latency')
  async getInferenceLatency(
    @Param('id', ValidateInstanceIdPipe) id: string,
    @Query('windowMs') windowMs?: string,
  ) {
    let parsedWindowMs: number | undefined;
    if (windowMs !== undefined) {
      const parsed = Number(windowMs);
      if (Number.isInteger(parsed) === false || parsed <= 0) {
        throw new HttpException(
          'windowMs must be a positive integer (milliseconds)',
          HttpStatus.BAD_REQUEST,
        );
      }
      parsedWindowMs = parsed;
    }
    try {
      const profile = await this.inferenceLatencyService.getProfile(id, {
        windowMs: parsedWindowMs,
      });
      const sla =
        this.inferenceLatencyProService === null
          ? null
          : this.inferenceLatencyProService.getSlaStatus(id);
      return { profile, sla };
    } catch (error) {
      throw mapMcpError(this.logger, error, 'Failed to get inference latency profile');
    }
  }
}
