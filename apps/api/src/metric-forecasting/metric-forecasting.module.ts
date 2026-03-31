import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { MetricForecastingService } from './metric-forecasting.service';
import { MetricForecastingController } from './metric-forecasting.controller';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [MetricForecastingService],
  controllers: [MetricForecastingController],
  exports: [MetricForecastingService],
})
export class MetricForecastingModule {}
