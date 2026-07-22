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
import { INFERENCE_LATENCY_PRO_SERVICE, IInferenceLatencyProService, MetricKind } from '@betterdb/shared';
import { AgentTokenGuard } from '../common/guards/agent-token.guard';
import { VectorIndexInfo } from '../common/types/metrics.types';
import { ValidateInstanceIdPipe, mapMcpError, safeParseInt } from './mcp-helpers';
import { MetricForecastingService } from '../metric-forecasting/metric-forecasting.service';
import { VectorSearchService } from '../vector-search/vector-search.service';
import {
  InferenceLatencyService,
  InferenceLatencyValidationError,
} from '../inference-latency/inference-latency.service';
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
      const indexes = settled
        .filter((result): result is PromiseFulfilledResult<VectorIndexInfo> => {
          return result.status === 'fulfilled';
        })
        .map((result) => {
          return result.value;
        });
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
    try {
      const profile = await this.inferenceLatencyService.getProfile(id, {
        windowMs: safeParseInt(windowMs),
      });
      const sla =
        this.inferenceLatencyProService === null
          ? null
          : this.inferenceLatencyProService.getSlaStatus(id);
      return { profile, sla };
    } catch (error) {
      if (error instanceof InferenceLatencyValidationError) {
        throw new HttpException(error.message, HttpStatus.BAD_REQUEST);
      }
      throw mapMcpError(this.logger, error, 'Failed to get inference latency profile');
    }
  }
}
