import { Module } from '@nestjs/common';
import { SlowLogAnalyticsService } from './slowlog-analytics.service';
import { SlowLogAnalyticsController } from './slowlog-analytics.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  providers: [SlowLogAnalyticsService],
  controllers: [SlowLogAnalyticsController],
  exports: [SlowLogAnalyticsService],
})
export class SlowLogAnalyticsModule {}
