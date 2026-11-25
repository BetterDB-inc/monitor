import { Test, TestingModule } from '@nestjs/testing';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import {
  DeliveryStatus,
  WebhookEventType,
  type Webhook,
  type WebhookPayload,
} from '@betterdb/shared';
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

  describe('for the other connections of the cluster', () => {
    const failover = {
      clusterState: 'fail',
      previousState: 'ok',
      reasons: ['cluster_state'],
      slotsAssigned: 16384,
      slotsFailed: 12,
      knownNodes: 6,
      timestamp: 1_700_000_000_000,
      instance: { host: '10.0.0.1', port: 6379 },
      connectionId: 'seed',
    };

    it('dispatches once more for each of them with its own instance', async () => {
      await service.dispatchClusterFailover({
        ...failover,
        alsoScopedTo: [{ connectionId: 'manual', instance: { host: '10.0.1.1', port: 6380 } }],
      });

      expect(webhookDispatcher.dispatchEvent).toHaveBeenCalledTimes(2);
      const [eventType, payload, connectionId] = webhookDispatcher.dispatchEvent.mock.calls[1];
      expect(eventType).toBe(WebhookEventType.CLUSTER_FAILOVER);
      expect(connectionId).toBe('manual');
      expect(payload).toMatchObject({
        clusterState: 'fail',
        message: 'Cluster state changed from ok to fail',
        instance: { host: '10.0.1.1', port: 6380 },
      });
    });

    it('keeps the filing connection as the only one that reaches global webhooks', async () => {
      await service.dispatchClusterFailover({
        ...failover,
        alsoScopedTo: [{ connectionId: 'manual', instance: { host: '10.0.1.1', port: 6380 } }],
      });

      const [filing, scoped] = webhookDispatcher.dispatchEvent.mock.calls;
      expect(filing[3]).toBeUndefined();
      expect(scoped[3].skip({ id: 'global' })).toBe(true);
      expect(scoped[3].skip({ id: 'on-seed', connectionId: 'seed' })).toBe(true);
      expect(scoped[3].skip({ id: 'on-manual', connectionId: 'manual' })).toBe(false);
    });

    it('delivers to every webhook of the cluster exactly once', async () => {
      const webhook = (id: string, connectionId?: string): Webhook =>
        ({
          id,
          name: id,
          url: 'https://example.com/hook',
          enabled: true,
          events: [WebhookEventType.CLUSTER_FAILOVER],
          retryPolicy: { maxRetries: 0, backoffMultiplier: 2, initialDelayMs: 1, maxDelayMs: 1 },
          connectionId,
          createdAt: 0,
          updatedAt: 0,
        }) as Webhook;
      const webhooks = [
        webhook('global'),
        webhook('on-seed', 'seed'),
        webhook('on-manual', 'manual'),
        webhook('second-on-manual', 'manual'),
        webhook('on-member', 'member-1'),
        webhook('on-other-cluster', 'elsewhere'),
      ];
      const dispatcher = new WebhookDispatcherService(
        {
          createDelivery: jest.fn(async (delivery) => ({ ...delivery, id: `d-${delivery.webhookId}` })),
        } as never,
        {
          getWebhooksByEvent: jest.fn(async (_event: WebhookEventType, connectionId?: string) =>
            webhooks.filter((hook) => !hook.connectionId || hook.connectionId === connectionId),
          ),
        } as never,
        { get: jest.fn((_key: string, fallback?: unknown) => fallback) } as never,
      );
      const sent = jest
        .spyOn(dispatcher as never, 'sendWebhook' as never)
        .mockResolvedValue(DeliveryStatus.SUCCESS as never);
      const real = new WebhookEventsProService(dispatcher, licenseService as never);

      await real.dispatchClusterFailover({
        ...failover,
        alsoScopedTo: [
          { connectionId: 'manual', instance: { host: '10.0.1.1', port: 6380 } },
          { connectionId: 'member-1', instance: { host: '10.0.0.2', port: 6379 } },
          { connectionId: 'member-2', instance: { host: '10.0.0.3', port: 6379 } },
        ],
      });

      const received = (sent.mock.calls as unknown as Array<[Webhook, string, WebhookPayload]>)
        .map(([hook, , payload]) => `${hook.id} as ${payload.data.connectionId}`)
        .sort();
      expect(received).toEqual([
        'global as seed',
        'on-manual as manual',
        'on-member as member-1',
        'on-seed as seed',
        'second-on-manual as manual',
      ]);
      await dispatcher.onModuleDestroy();
    });
  });
});
