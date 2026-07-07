import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType, LatencyRegressionDetectedData } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - dispatchLatencyRegressionDetected', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchEvent: jest.Mock };
  let licenseService: { getLicenseTier: jest.Mock };

  const testData: LatencyRegressionDetectedData = {
    kind: 'upgrade_regression',
    previousVersion: '8.1.0',
    currentVersion: '9.0.0',
    commands: [
      {
        command: 'hmget',
        baselineP99Us: 2000,
        currentP99Us: 6000,
        degradationFactor: 3,
        callsPerMin: 120,
      },
    ],
    topologyRefreshCorrelated: true,
    prefetchBatchMaxSize: 16,
    runbook: ['step 1', 'step 2'],
    message: 'P99 latency regression after upgrade 8.1.0 -> 9.0.0',
    timestamp: 1_700_000_000_000,
    instance: { host: 'localhost', port: 6379 },
    connectionId: 'conn-42',
  };

  beforeEach(async () => {
    webhookDispatcher = {
      dispatchEvent: jest.fn().mockResolvedValue(undefined),
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

  it('dispatches latency.regression.detected with the full payload when Pro licensed', async () => {
    await service.dispatchLatencyRegressionDetected(testData);

    expect(webhookDispatcher.dispatchEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload, connectionId] = webhookDispatcher.dispatchEvent.mock.calls[0];

    expect(eventType).toBe(WebhookEventType.LATENCY_REGRESSION_DETECTED);
    expect(connectionId).toBe('conn-42');
    expect(payload).toMatchObject({
      kind: 'upgrade_regression',
      previousVersion: '8.1.0',
      currentVersion: '9.0.0',
      topologyRefreshCorrelated: true,
      prefetchBatchMaxSize: 16,
      runbook: ['step 1', 'step 2'],
      message: testData.message,
      instance: { host: 'localhost', port: 6379 },
    });
    expect(payload.commands).toHaveLength(1);
    expect(payload.commands[0].degradationFactor).toBe(3);
  });

  it('normalizes an absent prefetchBatchMaxSize to null', async () => {
    await service.dispatchLatencyRegressionDetected({
      ...testData,
      prefetchBatchMaxSize: undefined,
    });

    const [, payload] = webhookDispatcher.dispatchEvent.mock.calls[0];
    expect(payload.prefetchBatchMaxSize).toBeNull();
  });

  it('skips dispatch on Community tier', async () => {
    licenseService.getLicenseTier.mockReturnValue('community');

    await service.dispatchLatencyRegressionDetected(testData);

    expect(webhookDispatcher.dispatchEvent).not.toHaveBeenCalled();
  });
});
