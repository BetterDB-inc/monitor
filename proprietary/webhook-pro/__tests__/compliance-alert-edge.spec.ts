import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsEnterpriseService } from '../webhook-events-enterprise.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsEnterpriseService - dispatchComplianceAlert edge semantics', () => {
  let service: WebhookEventsEnterpriseService;
  let webhookDispatcher: {
    shouldFireAlert: jest.Mock;
    dispatchThresholdAlertPerWebhook: jest.Mock;
  };
  let licenseService: { getLicenseTier: jest.Mock };

  const testData = {
    complianceType: 'data_retention',
    severity: 'high',
    memoryUsedPercent: 85,
    maxmemoryPolicy: 'noeviction',
    message: 'Compliance alert: memory high with noeviction',
    timestamp: 1_700_000_000_000,
    instance: { host: 'localhost', port: 6379 },
    connectionId: 'conn-42',
  };

  beforeEach(async () => {
    webhookDispatcher = {
      shouldFireAlert: jest.fn().mockReturnValue(true),
      dispatchThresholdAlertPerWebhook: jest.fn().mockResolvedValue(true),
    };
    licenseService = {
      getLicenseTier: jest.fn().mockReturnValue('enterprise'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookEventsEnterpriseService,
        { provide: WebhookDispatcherService, useValue: webhookDispatcher },
        { provide: LicenseService, useValue: licenseService },
      ],
    }).compile();

    service = module.get(WebhookEventsEnterpriseService);
  });

  it('returns true when the OTLP alert edge fires', async () => {
    const fired = await service.dispatchComplianceAlert(testData);

    expect(fired).toBe(true);
    expect(webhookDispatcher.shouldFireAlert).toHaveBeenCalledWith(
      'compliance_alert_otlp:conn-42',
      85,
      80,
      true,
    );
    expect(webhookDispatcher.dispatchThresholdAlertPerWebhook).toHaveBeenCalledTimes(1);

    const [eventType, alertKey] = webhookDispatcher.dispatchThresholdAlertPerWebhook.mock.calls[0];
    expect(eventType).toBe(WebhookEventType.COMPLIANCE_ALERT);
    expect(alertKey).toBe('compliance_alert');
  });

  it('returns false when the OTLP edge is suppressed via hysteresis', async () => {
    webhookDispatcher.shouldFireAlert.mockReturnValue(false);

    const fired = await service.dispatchComplianceAlert(testData);

    expect(fired).toBe(false);
    expect(webhookDispatcher.dispatchThresholdAlertPerWebhook).toHaveBeenCalledTimes(1);
  });

  it('returns false without dispatching when not Enterprise tier', async () => {
    licenseService.getLicenseTier.mockReturnValue('pro');

    const fired = await service.dispatchComplianceAlert(testData);

    expect(fired).toBe(false);
    expect(webhookDispatcher.shouldFireAlert).not.toHaveBeenCalled();
    expect(webhookDispatcher.dispatchThresholdAlertPerWebhook).not.toHaveBeenCalled();
  });
});

describe('WebhookEventsEnterpriseService - OTLP compliance edge without webhook subscribers', () => {
  function setup() {
    const dispatcher = new WebhookDispatcherService(
      {} as never,
      { getWebhooksByEvent: jest.fn().mockResolvedValue([]) } as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
    );
    const service = new WebhookEventsEnterpriseService(dispatcher, {
      getLicenseTier: () => 'enterprise',
    } as never);
    const compliance = (connectionId: string, memoryUsedPercent: number) =>
      service.dispatchComplianceAlert({
        complianceType: 'data_retention',
        severity: 'high',
        memoryUsedPercent,
        maxmemoryPolicy: 'noeviction',
        message: 'Compliance alert: memory high with noeviction',
        timestamp: 0,
        instance: { host: connectionId, port: 6379 },
        connectionId,
      });
    return { compliance };
  }

  it('fires the OTLP edge once and suppresses repeats via hysteresis', async () => {
    const { compliance } = setup();
    expect(await compliance('conn-a', 85)).toBe(true);
    expect(await compliance('conn-a', 85)).toBe(false);
  });

  it('re-arms after usage drops below the recovery level', async () => {
    const { compliance } = setup();
    expect(await compliance('conn-a', 85)).toBe(true);
    expect(await compliance('conn-a', 50)).toBe(false);
    expect(await compliance('conn-a', 85)).toBe(true);
  });

  it('tracks each connection independently', async () => {
    const { compliance } = setup();
    expect(await compliance('conn-a', 85)).toBe(true);
    expect(await compliance('conn-b', 85)).toBe(true);
  });
});
