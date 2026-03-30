import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - dispatchMetricForecastLimit', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchThresholdAlert: jest.Mock };
  let licenseService: { getLicenseTier: jest.Mock };

  const testData = {
    event: 'metric_forecast.limit',
    metricKind: 'opsPerSec',
    currentValue: 50_000,
    ceiling: 80_000,
    timeToLimitMs: 7_200_000, // 2 hours
    threshold: 7_200_000,
    growthRate: 10_000,
    timestamp: Date.now(),
    instance: { host: 'localhost', port: 6379 },
    connectionId: 'conn-42',
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

  // ── Slice 11: Webhook Dispatch (Pro) ──

  it('11a: dispatches with correct parameters when Pro licensed', async () => {
    await service.dispatchMetricForecastLimit(testData);

    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledTimes(1);

    const [eventType, alertKey, value, threshold, isAbove] =
      webhookDispatcher.dispatchThresholdAlert.mock.calls[0];

    expect(eventType).toBe(WebhookEventType.METRIC_FORECAST_LIMIT);
    expect(isAbove).toBe(false);
    expect(value).toBe(7_200_000);
    expect(threshold).toBe(7_200_000);
  });

  it('11b: payload contains human-readable message and metric fields', async () => {
    await service.dispatchMetricForecastLimit(testData);

    const payload = webhookDispatcher.dispatchThresholdAlert.mock.calls[0][5];
    expect(payload.message).toContain('~2.0h');
    expect(payload.metricKind).toBe('opsPerSec');
    expect(payload.currentValue).toBe(50_000);
    expect(payload.ceiling).toBe(80_000);
  });

  it('11c: alert key includes connectionId and metricKind', async () => {
    await service.dispatchMetricForecastLimit(testData);

    const alertKey = webhookDispatcher.dispatchThresholdAlert.mock.calls[0][1];
    expect(alertKey).toBe('metric_forecast_limit:conn-42:opsPerSec');
  });

  // ── Slice 12: Webhook Skips (Community) ──

  it('12a: skips dispatch when Community tier', async () => {
    licenseService.getLicenseTier.mockReturnValue('community');

    await service.dispatchMetricForecastLimit(testData);

    expect(webhookDispatcher.dispatchThresholdAlert).not.toHaveBeenCalled();
  });
});
