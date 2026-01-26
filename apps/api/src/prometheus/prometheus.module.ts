import { Module } from '@nestjs/common';
import { PrometheusController } from './prometheus.controller';
import { PrometheusService } from './prometheus.service';
import { StorageModule } from '../storage/storage.module';
import { DatabaseModule } from '../database/database.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [StorageModule, DatabaseModule, WebhooksModule],
  controllers: [PrometheusController],
  providers: [PrometheusService],
  exports: [PrometheusService],
})
export class PrometheusModule {}
