import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '../storage/storage.module';
import { PrometheusModule } from '../prometheus/prometheus.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditStatsModule } from './audit-stats.module';

@Module({
  imports: [ConfigModule, StorageModule, PrometheusModule, WebhooksModule, AuditStatsModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
