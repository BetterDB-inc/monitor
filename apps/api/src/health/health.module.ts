import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ConfigHazardService } from '../monitor/config-hazard.service';

@Module({
  imports: [WebhooksModule],
  controllers: [HealthController],
  providers: [HealthService, ConfigHazardService],
  exports: [HealthService, ConfigHazardService],
})
export class HealthModule {}
