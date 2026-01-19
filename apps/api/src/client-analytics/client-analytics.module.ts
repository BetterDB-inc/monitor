import { Module } from '@nestjs/common';
import { ClientAnalyticsController } from './client-analytics.controller';
import { ClientAnalyticsService } from './client-analytics.service';
import { ClientAnalyticsAnalysisService } from './client-analytics-analysis.service';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';
import { PrometheusModule } from '../prometheus/prometheus.module';
import { LicenseModule } from '@proprietary/license';

@Module({
  imports: [DatabaseModule, StorageModule, PrometheusModule, LicenseModule],
  controllers: [ClientAnalyticsController],
  providers: [ClientAnalyticsService, ClientAnalyticsAnalysisService],
  exports: [ClientAnalyticsService, ClientAnalyticsAnalysisService],
})
export class ClientAnalyticsModule {}
