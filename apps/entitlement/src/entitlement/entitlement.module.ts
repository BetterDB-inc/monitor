import { Module } from '@nestjs/common';
import { EntitlementService } from './entitlement.service';
import { EntitlementController } from './entitlement.controller';

@Module({
  controllers: [EntitlementController],
  providers: [EntitlementService],
  exports: [EntitlementService],
})
export class EntitlementModule {}
