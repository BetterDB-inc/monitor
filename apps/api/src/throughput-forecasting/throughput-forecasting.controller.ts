import { Controller, Get, Put, Body } from '@nestjs/common';
import { ThroughputForecastingService } from './throughput-forecasting.service';
import { ConnectionId } from '../common/decorators/connection-id.decorator';
import type { ThroughputForecast, ThroughputSettings, ThroughputSettingsUpdate } from '@betterdb/shared';

@Controller('throughput-forecasting')
export class ThroughputForecastingController {
  constructor(private readonly service: ThroughputForecastingService) {}

  @Get('forecast')
  async getForecast(@ConnectionId() connectionId?: string): Promise<ThroughputForecast> {
    return this.service.getForecast(connectionId || 'env-default');
  }

  @Get('settings')
  async getSettings(@ConnectionId() connectionId?: string): Promise<ThroughputSettings> {
    return this.service.getSettings(connectionId || 'env-default');
  }

  @Put('settings')
  async updateSettings(
    @ConnectionId() connectionId?: string,
    @Body() updates?: ThroughputSettingsUpdate,
  ): Promise<ThroughputSettings> {
    return this.service.updateSettings(connectionId || 'env-default', updates || {});
  }
}
