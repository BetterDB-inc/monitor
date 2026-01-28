import { Module } from '@nestjs/common';
import { PrometheusController } from './prometheus.controller';
import { PrometheusService } from './prometheus.service';
import { StorageModule } from '../storage/storage.module';
import { DatabaseModule } from '../database/database.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { SlowLogAnalyticsModule } from '../slowlog-analytics/slowlog-analytics.module';
import { CommandLogAnalyticsModule } from '../commandlog-analytics/commandlog-analytics.module';

@Module({
  imports: [
    StorageModule,
    DatabaseModule,
    WebhooksModule,
    SlowLogAnalyticsModule,
    CommandLogAnalyticsModule,
  ],
  controllers: [PrometheusController],
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}
