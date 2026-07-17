import { Module } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { EntitlementController } from './entitlement.controller';
import { LicenseSigningService } from './license-signing.service';
import { OfflineLicenseService } from './offline-license.service';
import { OfflineLicenseController } from './offline-license.controller';

@Module({
  controllers: [EntitlementController, OfflineLicenseController],
  providers: [EntitlementService, LicenseSigningService, OfflineLicenseService],
  exports: [EntitlementService, LicenseSigningService],
})
export class EntitlementModule {}
