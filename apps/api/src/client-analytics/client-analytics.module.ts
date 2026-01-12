import { Module } from '@nestjs/common';
import { ClientAnalyticsController } from './client-analytics.controller';
import { ClientAnalyticsService } from './client-analytics.service';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { PrometheusModule } from '../prometheus/prometheus.module';

@Module({
  imports: [DatabaseModule, StorageModule, PrometheusModule],
  controllers: [ClientAnalyticsController],
  providers: [ClientAnalyticsService],
  exports: [ClientAnalyticsService],
})
export class ClientAnalyticsModule {}
