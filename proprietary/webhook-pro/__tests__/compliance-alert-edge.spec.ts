import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsEnterpriseService } from '../webhook-events-enterprise.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsEnterpriseService - dispatchComplianceAlert edge semantics', () => {
  let service: WebhookEventsEnterpriseService;
  let webhookDispatcher: { dispatchThresholdAlert: jest.Mock };
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
      dispatchThresholdAlert: jest.fn().mockResolvedValue(true),
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

  it('returns true when the dispatcher fires the alert edge', async () => {
    const fired = await service.dispatchComplianceAlert(testData);

    expect(fired).toBe(true);
    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledTimes(1);

    const [eventType, alertKey] = webhookDispatcher.dispatchThresholdAlert.mock.calls[0];
    expect(eventType).toBe(WebhookEventType.COMPLIANCE_ALERT);
    expect(alertKey).toBe('compliance_alert');
  });

  it('returns false when the dispatcher suppresses a repeat via hysteresis', async () => {
    webhookDispatcher.dispatchThresholdAlert.mockResolvedValue(false);

    const fired = await service.dispatchComplianceAlert(testData);

    expect(fired).toBe(false);
    expect(webhookDispatcher.dispatchThresholdAlert).toHaveBeenCalledTimes(1);
  });

  it('returns false without dispatching when not Enterprise tier', async () => {
    licenseService.getLicenseTier.mockReturnValue('pro');

    const fired = await service.dispatchComplianceAlert(testData);

    expect(fired).toBe(false);
    expect(webhookDispatcher.dispatchThresholdAlert).not.toHaveBeenCalled();
  });
});
