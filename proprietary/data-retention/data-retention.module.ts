import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { StorageModule } from '@app/storage/storage.module';
import { DataRetentionService } from './data-retention.service';

@Module({
  imports: [ScheduleModule.forRoot(), StorageModule],
  providers: [DataRetentionService],
})
export class DataRetentionModule {}
