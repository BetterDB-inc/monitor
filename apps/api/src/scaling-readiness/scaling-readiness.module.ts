import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';
import { MetricForecastingModule } from '../metric-forecasting/metric-forecasting.module';
import { ScalingReadinessService } from './scaling-readiness.service';
import { ScalingReadinessController } from './scaling-readiness.controller';

@Module({
  imports: [StorageModule, ConnectionsModule, MetricForecastingModule],
  providers: [ScalingReadinessService],
  controllers: [ScalingReadinessController],
  exports: [ScalingReadinessService],
})
export class ScalingReadinessModule {}
