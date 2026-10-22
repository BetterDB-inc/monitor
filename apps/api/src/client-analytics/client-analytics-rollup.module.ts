import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '../storage/storage.module';
import { ClientAnalyticsRollupService } from './client-analytics-rollup.service';

/**
 * Standalone so both PrometheusModule and ClientAnalyticsModule can import it
 * without a cycle: it depends on storage and config only.
 */
@Module({
  imports: [StorageModule, ConfigModule],
  providers: [ClientAnalyticsRollupService],
  exports: [ClientAnalyticsRollupService],
})
export class ClientAnalyticsRollupModule {}
