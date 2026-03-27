import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { ThroughputForecastingService } from './throughput-forecasting.service';
import { ThroughputForecastingController } from './throughput-forecasting.controller';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [ThroughputForecastingService],
  controllers: [ThroughputForecastingController],
  exports: [ThroughputForecastingService],
})
export class ThroughputForecastingModule {}
