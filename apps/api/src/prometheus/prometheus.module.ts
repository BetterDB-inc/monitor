import { Module, forwardRef } from '@nestjs/common';
import { PrometheusController } from './prometheus.controller';
import { PrometheusService } from './prometheus.service';
import { StorageModule } from '../storage/storage.module';
import { DatabaseModule } from '../database/database.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SlowLogAnalyticsModule } from '../slowlog-analytics/slowlog-analytics.module';
import { CommandLogAnalyticsModule } from '../commandlog-analytics/commandlog-analytics.module';
import { HealthModule } from '../health/health.module';

@Module({
  imports: [
    StorageModule,
    DatabaseModule,
    WebhooksModule,
    SlowLogAnalyticsModule,
    CommandLogAnalyticsModule,
    forwardRef(() => HealthModule),
  ],
  controllers: [PrometheusController],
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}
