import { Module } from '@nestjs/common';
import { LatencyAnalyticsService } from './latency-analytics.service';
import { LatencyAnalyticsController } from './latency-analytics.controller';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [LatencyAnalyticsService],
  controllers: [LatencyAnalyticsController],
  exports: [LatencyAnalyticsService],
})
export class LatencyAnalyticsModule {}
