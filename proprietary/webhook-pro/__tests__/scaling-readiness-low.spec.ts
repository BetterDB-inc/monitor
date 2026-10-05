import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - dispatchScalingReadinessLow', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchThresholdAlert: jest.Mock };
  let licenseService: { getLicenseTier: jest.Mock };

  const data = {
    connectionId: 'conn-1',
    score: 32,
    threshold: 40,
    band: 'red' as const,
    bindingDimension: 'memory' as const,
    summary: 'Memory is your binding constraint (91% of 4 GB).',
    dimensions: [{ key: 'memory' as const, score: 12, excludedReason: null }],
    timestamp: 123,
  };

  beforeEach(async () => {
    webhookDispatcher = {
      dispatchThresholdAlert: jest.fn().mockResolvedValue(undefined),
    };
    licenseService = {
      getLicenseTier: jest.fn().mockReturnValue('pro'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEventsProService,
        { provide: WebhookDispatcherService, useValue: webhookDispatcher },
        { provide: LicenseService, useValue: licenseService },
      ],
    }).compile();

    service = module.get(WebhookEventsProService);
  });

  it('dispatches a below-threshold alert keyed per connection', async () => {
    await service.dispatchScalingReadinessLow(data);
    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledWith(
      WebhookEventType.SCALING_READINESS_LOW,
      'scaling_readiness_low:conn-1',
      32,
      40,
      false,
      expect.objectContaining({
        score: 32,
        threshold: 40,
        band: 'red',
        bindingDimension: 'memory',
        summary: data.summary,
        dimensions: data.dimensions,
        timestamp: 123,
        message: `Scaling readiness 32 dropped to 40 or below: ${data.summary}`,
      }),
      'conn-1',
    );
  });

  it('skips dispatch without a Pro license', async () => {
    licenseService.getLicenseTier.mockReturnValue('community');
    await service.dispatchScalingReadinessLow(data);
    expect(webhookDispatcher.dispatchThresholdAlert).not.toHaveBeenCalled();
  });
});
