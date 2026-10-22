import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - replication lag', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: {
    dispatchThresholdAlertPerWebhook: jest.Mock;
    clearThresholdAlertPerWebhook: jest.Mock;
  };

  const data = {
    lagSeconds: 30,
    threshold: 10,
    masterLinkStatus: 'up',
    timestamp: 123,
    instance: { host: '10.0.0.1', port: 6379 },
    connectionId: 'conn-1',
  };

  beforeEach(async () => {
    webhookDispatcher = {
      dispatchThresholdAlertPerWebhook: jest.fn().mockResolvedValue(true),
      clearThresholdAlertPerWebhook: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEventsProService,
        { provide: WebhookDispatcherService, useValue: webhookDispatcher },
        { provide: LicenseService, useValue: { getLicenseTier: jest.fn().mockReturnValue('pro') } },
      ],
    }).compile();

    service = module.get(WebhookEventsProService);
  });

  it('dispatches and clears under the same prefix and connection', async () => {
    await service.dispatchReplicationLag(data);
    service.clearReplicationLag('conn-1');

    expect(webhookDispatcher.dispatchThresholdAlertPerWebhook).toHaveBeenCalledWith(
      WebhookEventType.REPLICATION_LAG,
      'replication_lag',
      30,
      'replicationLagSeconds',
      true,
      expect.any(Function),
      'conn-1',
    );
    expect(webhookDispatcher.clearThresholdAlertPerWebhook).toHaveBeenCalledWith(
      'replication_lag',
      'conn-1',
    );
  });
});
