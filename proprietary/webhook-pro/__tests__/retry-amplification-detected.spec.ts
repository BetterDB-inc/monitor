import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import {
  WebhookEventType,
  RetryAmplificationDetectedData,
  getRequiredTierForEvent,
  Tier,
} from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - dispatchRetryAmplificationDetected', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchEvent: jest.Mock };
  let licenseService: { getLicenseTier: jest.Mock };

  const data: RetryAmplificationDetectedData = {
    level: 'critical',
    trigger: 'latency',
    windows: 4,
    loadRatio: 2.1,
    pattern: 'rising',
    correlation: 0.93,
    topContributors: [
      {
        key: 'checkout',
        keyKind: 'name',
        commandRateGrowth: 4.8,
        newConnections: 12,
        connections: 40,
      },
    ],
    message: 'CRITICAL: Retry amplification',
    timestamp: 1_700_000_000_000,
    instance: { host: 'localhost', port: 6379 },
    connectionId: 'conn-7',
  };

  beforeEach(async () => {
    webhookDispatcher = { dispatchEvent: jest.fn().mockResolvedValue(undefined) };
    licenseService = { getLicenseTier: jest.fn().mockReturnValue('pro') };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEventsProService,
        { provide: WebhookDispatcherService, useValue: webhookDispatcher },
        { provide: LicenseService, useValue: licenseService },
      ],
    }).compile();
    service = module.get(WebhookEventsProService);
  });

  it('is a Pro event', () => {
    expect(getRequiredTierForEvent(WebhookEventType.RETRY_AMPLIFICATION_DETECTED)).toBe(Tier.pro);
  });

  it('dispatches the structured payload keyed to the connection', async () => {
    await service.dispatchRetryAmplificationDetected(data);

    const { connectionId, ...payload } = data;
    expect(webhookDispatcher.dispatchEvent).toHaveBeenCalledWith(
      WebhookEventType.RETRY_AMPLIFICATION_DETECTED,
      payload,
      connectionId,
    );
  });

  it('skips the event without a Pro license', async () => {
    licenseService.getLicenseTier.mockReturnValue('community');
    await service.dispatchRetryAmplificationDetected(data);
    expect(webhookDispatcher.dispatchEvent).not.toHaveBeenCalled();
  });
});
