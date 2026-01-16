import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LicenseService } from './license.service';
import { LicenseGuard } from './license.guard';
import { LicenseController } from './license.controller';
import { RetentionService } from './retention.service';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [LicenseController],
  providers: [LicenseService, LicenseGuard, RetentionService],
  exports: [LicenseService, LicenseGuard, RetentionService],
})
export class LicenseModule {}
