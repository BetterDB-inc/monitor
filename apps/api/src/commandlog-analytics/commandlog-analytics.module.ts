import { Module } from '@nestjs/common';
import { CommandLogAnalyticsService } from './commandlog-analytics.service';
import { CommandLogAnalyticsController } from './commandlog-analytics.controller';
import { DatabaseModule } from '../database/database.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [DatabaseModule, StorageModule],
  providers: [CommandLogAnalyticsService],
  controllers: [CommandLogAnalyticsController],
  exports: [CommandLogAnalyticsService],
})
export class CommandLogAnalyticsModule {}
