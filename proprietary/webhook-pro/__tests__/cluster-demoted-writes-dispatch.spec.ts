import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - dispatchClusterDemotedWrites', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchEvent: jest.Mock };
  let licenseService: { getLicenseTier: jest.Mock };

  const alert = {
    nodeId: 'node-a',
    nodeAddress: '10.0.0.1:6379',
    disagreementMs: 5_000,
    demotedForMs: 6_000,
    opsPerSec: 120,
    writeCallsDelta: 12,
    severity: 'critical' as const,
    message: 'Node node-a was demoted but still reports role:master',
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

  it('dispatches its own event type, not cluster.failover', async () => {
    await service.dispatchClusterDemotedWrites(alert);

    expect(webhookDispatcher.dispatchEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload, connectionId] = webhookDispatcher.dispatchEvent.mock.calls[0];

    expect(eventType).toBe(WebhookEventType.CLUSTER_DEMOTED_WRITES);
    expect(connectionId).toBe('conn-7');
    expect(payload).toMatchObject({
      nodeId: 'node-a',
      nodeAddress: '10.0.0.1:6379',
      disagreementMs: 5_000,
      demotedForMs: 6_000,
      opsPerSec: 120,
      writeCallsDelta: 12,
      severity: 'critical',
    });
  });

  it('carries no write delta when the node exposed no commandstats', async () => {
    await service.dispatchClusterDemotedWrites({ ...alert, writeCallsDelta: undefined });

    const [, payload] = webhookDispatcher.dispatchEvent.mock.calls[0];

    expect(payload.writeCallsDelta).toBeUndefined();
    expect(payload.opsPerSec).toBe(120);
  });

  it('carries the severity through so a receiver can tell a page from a warning', async () => {
    await service.dispatchClusterDemotedWrites({
      ...alert,
      writeCallsDelta: undefined,
      severity: 'warning',
    });

    const [, payload] = webhookDispatcher.dispatchEvent.mock.calls[0];

    expect(payload.severity).toBe('warning');
  });

  it('stays silent without a PRO license', async () => {
    licenseService.getLicenseTier.mockReturnValue('community');

    await service.dispatchClusterDemotedWrites(alert);

    expect(webhookDispatcher.dispatchEvent).not.toHaveBeenCalled();
  });
});
