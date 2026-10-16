import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - replication lag', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchThresholdAlert: jest.Mock; clearThresholdAlert: jest.Mock };

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
      dispatchThresholdAlert: jest.fn().mockResolvedValue(true),
      clearThresholdAlert: jest.fn(),
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

  it('keys the lag alert per connection', async () => {
    await service.dispatchReplicationLag(data);
    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledWith(
      WebhookEventType.REPLICATION_LAG,
      'replication_lag:conn-1',
      30,
      10,
      true,
      expect.objectContaining({ lagSeconds: 30, masterLinkStatus: 'up' }),
      'conn-1',
    );
  });

  it('clears the same per-connection alert state', () => {
    service.clearReplicationLag('conn-1');
    expect(webhookDispatcher.clearThresholdAlert).toHaveBeenCalledWith('replication_lag:conn-1');
  });
});
