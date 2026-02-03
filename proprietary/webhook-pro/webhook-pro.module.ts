import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StorageModule } from '@app/storage/storage.module';
import { WebhooksModule } from '@app/webhooks/webhooks.module';
import { SettingsModule } from '@app/settings/settings.module';
import { LicenseModule } from '@proprietary/license';
import { WebhookProService } from './webhook-pro.service';
import { WebhookAnomalyIntegrationService } from './webhook-anomaly-integration.service';
import { WebhookDlqService } from './webhook-dlq.service';
import { WebhookEventsProService } from './webhook-events-pro.service';
import { WebhookEventsEnterpriseService } from './webhook-events-enterprise.service';
import { ConfigMonitorService } from './config-monitor.service';
import {
  WEBHOOK_EVENTS_PRO_SERVICE,
  WEBHOOK_EVENTS_ENTERPRISE_SERVICE,
} from '@betterdb/shared';

@Global()
@Module({
  imports: [ConfigModule, StorageModule, WebhooksModule, SettingsModule, LicenseModule],
  providers: [
    WebhookProService,
    WebhookAnomalyIntegrationService,
    WebhookDlqService,
    WebhookEventsProService,
    { provide: WEBHOOK_EVENTS_PRO_SERVICE, useExisting: WebhookEventsProService },
    WebhookEventsEnterpriseService,
    { provide: WEBHOOK_EVENTS_ENTERPRISE_SERVICE, useExisting: WebhookEventsEnterpriseService },
    ConfigMonitorService,
  ],
  exports: [
    WebhookProService,
    WebhookAnomalyIntegrationService,
    WebhookDlqService,
    WebhookEventsProService,
    WEBHOOK_EVENTS_PRO_SERVICE,
    WebhookEventsEnterpriseService,
    WEBHOOK_EVENTS_ENTERPRISE_SERVICE,
    ConfigMonitorService,
  ],
})
export class WebhookProModule {}
