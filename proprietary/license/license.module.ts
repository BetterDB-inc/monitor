import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LicenseService } from './license.service';
import { LicenseGuard } from './license.guard';
import { LicenseController } from './license.controller';

@Global()
@Module({
  imports: [ConfigModule],
  controllers: [LicenseController],
  providers: [LicenseService, LicenseGuard],
  exports: [LicenseService, LicenseGuard],
})
export class LicenseModule {}
