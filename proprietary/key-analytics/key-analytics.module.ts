import { Module } from '@nestjs/common';
import { KeyAnalyticsService } from './key-analytics.service';
import { KeyAnalyticsController } from './key-analytics.controller';
import { StorageModule } from '@app/storage/storage.module';
import { LicenseModule } from '@proprietary/license/license.module';

@Module({
  imports: [StorageModule, LicenseModule],
  providers: [KeyAnalyticsService],
  controllers: [KeyAnalyticsController],
  exports: [KeyAnalyticsService],
})
export class KeyAnalyticsModule {}
