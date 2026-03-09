import { Module } from '@nestjs/common';
import { MemoryAnalyticsService } from './memory-analytics.service';
import { MemoryAnalyticsController } from './memory-analytics.controller';
import { StorageModule } from '../storage/storage.module';
import { ConnectionsModule } from '../connections/connections.module';

@Module({
  imports: [StorageModule, ConnectionsModule],
  providers: [MemoryAnalyticsService],
  controllers: [MemoryAnalyticsController],
  exports: [MemoryAnalyticsService],
})
export class MemoryAnalyticsModule {}
