import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { WebhooksService } from './webhooks.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookProcessorService } from './webhook-processor.service';
import { WebhookHealthService } from './webhook-health.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [StorageModule],
  providers: [
    WebhooksService,
    WebhookDispatcherService,
    WebhookProcessorService,
    WebhookHealthService,
  ],
  controllers: [WebhooksController],
  exports: [
    WebhookDispatcherService, // Only export dispatcher for event monitors to use
  ],
})
export class WebhooksModule {}
