import { Module } from '@nestjs/common';
import { ANOMALY_SERVICE } from '@betterdb/shared';
import { AnomalyService } from './anomaly.service';
import { AnomalyController } from './anomaly.controller';
import { StorageModule } from '@app/storage/storage.module';
import { PrometheusModule } from '@app/prometheus/prometheus.module';
import { SlowLogAnalyticsModule } from '@app/slowlog-analytics/slowlog-analytics.module';
import { ClusterModule } from '@app/cluster/cluster.module';

@Module({
  imports: [StorageModule, PrometheusModule, SlowLogAnalyticsModule, ClusterModule],
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
