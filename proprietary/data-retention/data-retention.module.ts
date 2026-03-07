import { Module } from '@nestjs/common';
import { StorageModule } from '@app/storage/storage.module';
import { DataRetentionService } from './data-retention.service';

@Module({
  imports: [StorageModule],
  providers: [DataRetentionService],
})
export class DataRetentionModule {}
