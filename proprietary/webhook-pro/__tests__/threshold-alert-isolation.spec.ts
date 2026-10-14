import { WebhookEventType, type Webhook } from '@betterdb/shared';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventsProService } from '../webhook-events-pro.service';
import { WebhookEventsEnterpriseService } from '../webhook-events-enterprise.service';

function webhook(id: string, thresholds: Webhook['thresholds'] = {}): Webhook {
  return {
    id,
    name: id,
    url: `https://hooks.example.com/${id}`,
    enabled: true,
    events: [
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.SLOWLOG_THRESHOLD,
      WebhookEventType.COMPLIANCE_ALERT,
      WebhookEventType.LATENCY_SPIKE,
      WebhookEventType.CONNECTION_SPIKE,
    ],
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
    .mockImplementation((async (event: { data: Record<string, unknown>; connectionId?: string }, targets?: Webhook[]) => {
      // Per-webhook alerts pass explicit targets; broadcast alerts (spikes) resolve them later.
      const webhookId = targets?.[0]?.id ?? '*';
      delivered.push({ webhookId, connectionId: event.connectionId, threshold: event.data.threshold });
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
  const slowlog = (connectionId: string, slowlogCount: number) =>
    pro.dispatchSlowlogThreshold({
      slowlogCount,
      threshold: 100,
      timestamp: 0,
      instance: { host: connectionId, port: 6379 },
      connectionId,
    });
  const enterprise = new WebhookEventsEnterpriseService(dispatcher, {
    getLicenseTier: () => 'enterprise',
  } as never);
  const compliance = (connectionId: string, memoryUsedPercent: number) =>
    enterprise.dispatchComplianceAlert({
      complianceType: 'data_retention',
      severity: 'high',
      memoryUsedPercent,
      maxmemoryPolicy: 'noeviction',
      message: 'memory high with noeviction',
      timestamp: 0,
      instance: { host: connectionId, port: 6379 },
      connectionId,
    });
  const latency = (connectionId: string, value: number) =>
    pro.dispatchLatencySpike({
      currentLatency: value,
      baseline: 1,
      threshold: 2,
      timestamp: 0,
      instance: { host: connectionId, port: 6379 },
      connectionId,
    });
  const connSpike = (connectionId: string, value: number) =>
    pro.dispatchConnectionSpike({
      currentConnections: value,
      baseline: 10,
      threshold: 2,
      timestamp: 0,
      instance: { host: connectionId, port: 6379 },
      connectionId,
    });
  return { delivered, lag, slowlog, compliance, latency, connSpike, pro };
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

  it("honors each webhook's slowlogCount threshold", async () => {
    const { delivered, slowlog } = setup([webhook('strict', { slowlogCount: 20 }), webhook('default')]);
    await slowlog('conn-a', 50);
    expect(delivered).toEqual([{ webhookId: 'strict', connectionId: 'conn-a', threshold: 20 }]);
  });

  it("honors each webhook's complianceMemoryPercent threshold", async () => {
    const { delivered, compliance } = setup([
      webhook('strict', { complianceMemoryPercent: 60 }),
      webhook('default'),
    ]);
    await compliance('conn-a', 70);
    expect(delivered).toEqual([{ webhookId: 'strict', connectionId: 'conn-a', threshold: 60 }]);
  });

  it('isolates compliance state per webhook and connection', async () => {
    const { delivered, compliance } = setup([webhook('w1')]);
    await compliance('conn-a', 85);
    await compliance('conn-b', 85);
    await compliance('conn-a', 85); // suppressed by hysteresis
    expect(delivered.map((d) => d.connectionId)).toEqual(['conn-a', 'conn-b']);
  });

  it.each([
    ['latency.spike', 'latency'],
    ['connection.spike', 'connSpike'],
  ] as const)('%s on conn-b is not suppressed while conn-a is still firing', async (_name, fn) => {
    const s = setup([webhook('w1')]);
    await s[fn]('conn-a', 1_000);
    await s[fn]('conn-b', 1_000);
    await s[fn]('conn-a', 1_000); // still firing -> suppressed
    expect(s.delivered.map((d) => d.connectionId)).toEqual(['conn-a', 'conn-b']);
  });

  it.each([
    ['latency.spike', 'latency'],
    ['connection.spike', 'connSpike'],
  ] as const)('%s on a healthy conn-b does not reset conn-a (no storm)', async (_name, fn) => {
    const s = setup([webhook('w1')]);
    for (let i = 0; i < 3; i++) {
      await s[fn]('conn-a', 1_000);
      await s[fn]('conn-b', 0);
    }
    expect(s.delivered.map((d) => d.connectionId)).toEqual(['conn-a']);
  });
});
