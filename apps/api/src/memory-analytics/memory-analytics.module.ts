import { Module } from '@nestjs/common';
import { MemoryAnalyticsService } from './memory-analytics.service';
import { MemoryAnalyticsController } from './memory-analytics.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  providers: [MemoryAnalyticsService],
  controllers: [MemoryAnalyticsController],
  exports: [MemoryAnalyticsService],
})
export class MemoryAnalyticsModule {}
