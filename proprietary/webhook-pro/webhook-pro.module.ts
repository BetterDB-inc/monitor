import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '@app/storage/storage.module';
import { WebhooksModule } from '@app/webhooks/webhooks.module';
import { LicenseModule } from '@proprietary/license';
import { WebhookProService } from './webhook-pro.service';
import { WebhookAnomalyIntegrationService } from './webhook-anomaly-integration.service';
import { WebhookDlqService } from './webhook-dlq.service';
import { WebhookEventsProService } from './webhook-events-pro.service';
import { WebhookEventsEnterpriseService } from './webhook-events-enterprise.service';

@Module({
  imports: [ConfigModule, StorageModule, WebhooksModule, LicenseModule],
  providers: [
    WebhookProService,
    WebhookAnomalyIntegrationService,
    WebhookDlqService,
    WebhookEventsProService,
    WebhookEventsEnterpriseService,
  ],
  exports: [
    WebhookProService,
    WebhookAnomalyIntegrationService,
    WebhookDlqService,
    WebhookEventsProService,
    WebhookEventsEnterpriseService,
  ],
})
export class WebhookProModule {}
