import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { DatabaseModule } from '../database/database.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [DatabaseModule, WebhooksModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
