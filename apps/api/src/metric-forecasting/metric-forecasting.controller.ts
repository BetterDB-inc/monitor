import { Controller, Get, Put, Body, Param } from '@nestjs/common';
import { MetricForecastingService } from './metric-forecasting.service';
import { MetricKindValidationPipe } from './pipes/metric-kind-validation.pipe';
import { UpdateMetricForecastSettingsDto } from './dto/update-metric-forecast-settings.dto';
import { ConnectionId } from '../common/decorators/connection-id.decorator';
import { ENV_DEFAULT_ID } from '../connections/connection-registry.service';
import type {
  MetricForecast,
  MetricForecastSettings,
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
    return this.service.getForecast(connectionId || ENV_DEFAULT_ID, metricKind);
  }

  @Get(':metricKind/settings')
  async getSettings(
    @Param('metricKind', MetricKindValidationPipe) metricKind: MetricKind,
    @ConnectionId() connectionId?: string,
  ): Promise<MetricForecastSettings> {
    return this.service.getSettings(connectionId || ENV_DEFAULT_ID, metricKind);
  }

  @Put(':metricKind/settings')
  async updateSettings(
    @Param('metricKind', MetricKindValidationPipe) metricKind: MetricKind,
    @ConnectionId() connectionId?: string,
    @Body() updates?: UpdateMetricForecastSettingsDto,
  ): Promise<MetricForecastSettings> {
    return this.service.updateSettings(connectionId || ENV_DEFAULT_ID, metricKind, updates || {});
  }
}
