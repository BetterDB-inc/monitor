import { Module } from '@nestjs/common';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import { AnomalyService } from './anomaly.service';
import { AnomalyController } from './anomaly.controller';
import { StorageModule } from '@app/storage/storage.module';
import { PrometheusModule } from '@app/prometheus/prometheus.module';
import { SlowLogAnalyticsModule } from '@app/slowlog-analytics/slowlog-analytics.module';

@Module({
  imports: [StorageModule, PrometheusModule, SlowLogAnalyticsModule],
  controllers: [AnomalyController],
  providers: [
    AnomalyService,
    {
      provide: ANOMALY_SERVICE,
      useExisting: AnomalyService,
    },
  ],
  exports: [AnomalyService, ANOMALY_SERVICE],
})
export class AnomalyModule {}
