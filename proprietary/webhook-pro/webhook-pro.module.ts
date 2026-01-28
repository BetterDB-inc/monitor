import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '@app/storage/storage.module';
import { WebhooksModule } from '@app/webhooks/webhooks.module';
import { DatabaseModule } from '@app/database/database.module';
import { SettingsModule } from '@app/settings/settings.module';
import { LicenseModule } from '@proprietary/license';
import { WebhookProService } from './webhook-pro.service';
import { WebhookAnomalyIntegrationService } from './webhook-anomaly-integration.service';
import { WebhookDlqService } from './webhook-dlq.service';
import { WebhookEventsProService } from './webhook-events-pro.service';
import { WebhookEventsEnterpriseService } from './webhook-events-enterprise.service';
import { ConfigMonitorService } from './config-monitor.service';

@Module({
  imports: [ConfigModule, StorageModule, WebhooksModule, DatabaseModule, SettingsModule, LicenseModule],
  providers: [
    WebhookProService,
    WebhookAnomalyIntegrationService,
    WebhookDlqService,
    WebhookEventsProService,
    WebhookEventsEnterpriseService,
    ConfigMonitorService,
  ],
  exports: [
    WebhookProService,
    WebhookAnomalyIntegrationService,
    WebhookDlqService,
    WebhookEventsProService,
    WebhookEventsEnterpriseService,
    ConfigMonitorService,
  ],
})
export class WebhookProModule {}
