import { WebhookEventType, type Webhook } from '@betterdb/shared';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventsProService } from '../webhook-events-pro.service';

function webhook(id: string, thresholds: Webhook['thresholds'] = {}): Webhook {
  return {
    id,
    name: id,
    url: `https://hooks.example.com/${id}`,
    enabled: true,
    events: [WebhookEventType.REPLICATION_LAG, WebhookEventType.SLOWLOG_THRESHOLD],
    retryPolicy: { maxRetries: 0, backoffMultiplier: 2, initialDelayMs: 1, maxDelayMs: 1 },
    thresholds,
    createdAt: 0,
    updatedAt: 0,
  };
}

function setup(hooks: Webhook[]) {
  const dispatcher = new WebhookDispatcherService(
    {} as never,
    { getWebhooksByEvent: jest.fn().mockResolvedValue(hooks) } as never,
    { get: (_key: string, fallback: unknown) => fallback } as never,
  );
  const delivered: Array<{ webhookId: string; connectionId?: string; threshold: unknown }> = [];
  jest
    .spyOn(dispatcher as never, 'dispatchPendingEvent')
    .mockImplementation((async (event: { data: Record<string, unknown>; connectionId?: string }, targets: Webhook[]) => {
      delivered.push({ webhookId: targets[0].id, connectionId: event.connectionId, threshold: event.data.threshold });
      return true;
    }) as never);
  const pro = new WebhookEventsProService(dispatcher, { getLicenseTier: () => 'pro' } as never);
  const lag = (connectionId: string, lagSeconds: number) =>
    pro.dispatchReplicationLag({
      lagSeconds,
      threshold: 10,
      masterLinkStatus: 'up',
      timestamp: 0,
      instance: { host: connectionId, port: 6379 },
      connectionId,
    });
  return { delivered, lag, pro };
}

describe('threshold alert state is isolated per connection', () => {
  it('fires once for a replica that stays lagged while a healthy replica is polled in between', async () => {
    const { delivered, lag } = setup([webhook('w1')]);
    for (let poll = 0; poll < 5; poll++) {
      await lag('replica-a', 30);
      await lag('replica-b', 0);
    }
    expect(delivered).toEqual([{ webhookId: 'w1', connectionId: 'replica-a', threshold: 10 }]);
  });

  it('does not suppress a second lagging replica while the first is still firing', async () => {
    const { delivered, lag } = setup([webhook('w1')]);
    await lag('replica-a', 30);
    await lag('replica-d', 45);
    expect(delivered.map((d) => d.connectionId)).toEqual(['replica-a', 'replica-d']);
  });

  it("honors each webhook's replicationLagSeconds threshold", async () => {
    const { delivered, lag } = setup([webhook('strict', { replicationLagSeconds: 2 }), webhook('default')]);
    await lag('replica-a', 5);
    expect(delivered).toEqual([{ webhookId: 'strict', connectionId: 'replica-a', threshold: 2 }]);
  });
});
