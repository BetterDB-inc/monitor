import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '@app/storage/storage.module';
import { WebhooksModule } from '@app/webhooks/webhooks.module';
import { WebhookProService } from './webhook-pro.service';
import { WebhookAnomalyIntegrationService } from './webhook-anomaly-integration.service';
import { WebhookDlqService } from './webhook-dlq.service';

@Module({
  imports: [ConfigModule, StorageModule, WebhooksModule],
  providers: [WebhookProService, WebhookAnomalyIntegrationService, WebhookDlqService],
  exports: [WebhookProService, WebhookAnomalyIntegrationService, WebhookDlqService],
})
export class WebhookProModule {}
