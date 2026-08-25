import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '@betterdb/shared';
import { LicenseService } from '@proprietary/licenses';

describe('WebhookEventsProService - dispatchClusterFailover', () => {
  let service: WebhookEventsProService;
  let webhookDispatcher: { dispatchEvent: jest.Mock };
  let licenseService: { getLicenseTier: jest.Mock };

  const changedNodes = [
    { nodeId: 'node-a', reason: 'role_change', from: 'replica', to: 'master' },
    { nodeId: 'node-b', reason: 'primary_change', from: 'node-a', to: 'node-c' },
  ];

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

  it('forwards changedNodes so a consumer can see which nodes moved', async () => {
    await service.dispatchClusterFailover({
      clusterState: 'ok',
      previousState: 'ok',
      reasons: ['role_change', 'primary_change'],
      changedNodes,
      slotsAssigned: 16384,
      slotsFailed: 0,
      knownNodes: 6,
      timestamp: 1_700_000_000_000,
      instance: { host: 'localhost', port: 6379 },
      connectionId: 'conn-7',
    });

    expect(webhookDispatcher.dispatchEvent).toHaveBeenCalledTimes(1);
    const [eventType, payload, connectionId] = webhookDispatcher.dispatchEvent.mock.calls[0];

    expect(eventType).toBe(WebhookEventType.CLUSTER_FAILOVER);
    expect(connectionId).toBe('conn-7');
    expect(payload.reasons).toEqual(['role_change', 'primary_change']);
    expect(payload.changedNodes).toEqual(changedNodes);
  });

  it('leaves changedNodes undefined for a state-only trigger', async () => {
    await service.dispatchClusterFailover({
      clusterState: 'fail',
      previousState: 'ok',
      reasons: ['cluster_state'],
      slotsAssigned: 16384,
      slotsFailed: 12,
      knownNodes: 6,
      timestamp: 1_700_000_000_000,
      instance: { host: 'localhost', port: 6379 },
    });

    const [, payload] = webhookDispatcher.dispatchEvent.mock.calls[0];
    expect(payload.changedNodes).toBeUndefined();
    expect(payload.message).toBe('Cluster state changed from ok to fail');
  });
});
