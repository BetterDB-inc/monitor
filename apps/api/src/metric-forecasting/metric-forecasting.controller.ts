import { Controller, Get, Put, Body, Param } from '@nestjs/common';
import { MetricForecastingService } from './metric-forecasting.service';
import { MetricKindValidationPipe } from './pipes/metric-kind-validation.pipe';
import { ConnectionId } from '../common/decorators/connection-id.decorator';
import type {
  MetricForecast,
  MetricForecastSettings,
  MetricForecastSettingsUpdate,
  MetricKind,
} from '@betterdb/shared';

@Controller('metric-forecasting')
export class MetricForecastingController {
  constructor(private readonly service: MetricForecastingService) {}

  @Get(':metricKind/forecast')
  async getForecast(
    @Param('metricKind', MetricKindValidationPipe) metricKind: MetricKind,
    @ConnectionId() connectionId?: string,
  ): Promise<MetricForecast> {
    return this.service.getForecast(connectionId || 'env-default', metricKind);
  }

  @Get(':metricKind/settings')
  async getSettings(
    @Param('metricKind', MetricKindValidationPipe) metricKind: MetricKind,
    @ConnectionId() connectionId?: string,
  ): Promise<MetricForecastSettings> {
    return this.service.getSettings(connectionId || 'env-default', metricKind);
  }

  @Put(':metricKind/settings')
  async updateSettings(
    @Param('metricKind', MetricKindValidationPipe) metricKind: MetricKind,
    @ConnectionId() connectionId?: string,
    @Body() updates?: MetricForecastSettingsUpdate,
  ): Promise<MetricForecastSettings> {
    return this.service.updateSettings(connectionId || 'env-default', metricKind, updates || {});
  }
}
