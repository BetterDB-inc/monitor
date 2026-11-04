import { WebhookEventType, type Webhook, type WebhookPayload } from '@betterdb/shared';
import { WebhookDispatcherService } from '@app/webhooks/webhook-dispatcher.service';
import { WebhookEventsProService } from '../webhook-events-pro.service';

const PRIMARY = 'primary-conn';
const REPLICA = 'replica-conn';
const REPLICA_ADDR = '10.0.0.2:6379';

function webhook(id: string, events: WebhookEventType[], replicationLagSeconds = 10): Webhook {
  return {
    id,
    name: id,
    url: `https://hooks.example.com/${id}`,
    enabled: true,
    events,
    retryPolicy: { maxRetries: 0, backoffMultiplier: 2, initialDelayMs: 1, maxDelayMs: 1 },
    thresholds: { replicationLagSeconds },
    createdAt: 0,
    updatedAt: 0,
  };
}

const BOTH = [WebhookEventType.REPLICATION_LAG, WebhookEventType.REPLICATION_DIVERGENCE];

function setup(hooks: Webhook[], { pairReplica = true, tier = 'pro' } = {}) {
  const getWebhooksByEvent = jest.fn(async (event: WebhookEventType) =>
    hooks.filter((hook) => hook.events.includes(event)),
  );
  let nextDeliveryId = 0;
  const storage = {
    createDelivery: jest.fn(async () => ({ id: `delivery-${nextDeliveryId++}` })),
    getDelivery: jest.fn(async () => ({ attempts: 0 })),
    updateDelivery: jest.fn(async () => undefined),
    getDeliveriesByWebhook: jest.fn(async () => []),
  };
  const dispatcher = new WebhookDispatcherService(
    storage as never,
    { getWebhooksByEvent, generateSignature: () => 'signature' } as never,
    { get: (_key: string, fallback: unknown) => fallback } as never,
  );
  const failing = new Set<string>();
  const retrying = new Set<string>();
  const delivered: Array<{ event: WebhookEventType; webhookId: string; level?: unknown }> = [];
  const attempts: Array<{ hook: Webhook; deliveryId: string; payload: WebhookPayload }> = [];
  jest.spyOn(dispatcher as never, 'post').mockImplementation((async (
    _url: string,
    headers: Record<string, string>,
    body: string,
  ) => {
    const webhookId = headers['X-Webhook-Id'];
    const payload = JSON.parse(body) as WebhookPayload;
    const hook = hooks.find((candidate) => candidate.id === webhookId)!;
    attempts.push({ hook, deliveryId: headers['X-Webhook-Delivery-Id'], payload });
    const status = failing.has(webhookId) ? 400 : retrying.has(webhookId) ? 503 : 200;
    if (status === 200) {
      delivered.push({ event: payload.event, webhookId, level: payload.data.level });
    }
    return { ok: status === 200, status, text: async () => '' };
  }) as never);

  const license = { tier };
  const pro = new WebhookEventsProService(dispatcher, {
    getLicenseTier: () => license.tier,
  } as never);
  pro.observeReplication(
    PRIMARY,
    {
      role: 'master',
      master_replid: 'replid-1',
      slave0: `ip=10.0.0.2,port=6379,state=online,offset=100,lag=0`,
    },
    { host: '10.0.0.1', port: 6379 },
  );
  if (pairReplica) {
    pro.observeReplication(
      REPLICA,
      { role: 'slave', master_replid: 'replid-1' },
      { host: '10.0.0.2', port: 6379 },
    );
  }

  const lag = (lagSeconds: number) =>
    pro.dispatchReplicationLag({
      lagSeconds,
      threshold: 10,
      masterLinkStatus: 'up',
      timestamp: 0,
      instance: { host: '10.0.0.2', port: 6379 },
      connectionId: REPLICA,
    });
  const divergence = (
    reason: 'not_acking' | 'growth' = 'not_acking',
    level: 'warning' | 'critical' = 'warning',
  ) =>
    pro.dispatchReplicationDivergence({
      replica: REPLICA_ADDR,
      level,
      reason,
      gapBytes: 0,
      secondsBehind: null,
      bytesPerSec: null,
      slopeBytesPerWindow: 0,
      windowCount: 2,
      correlatedSignals: [],
      message: 'replica stalled',
      timestamp: 0,
      instance: { host: '10.0.0.1', port: 6379 },
      connectionId: PRIMARY,
    });
  const recovered = async () => {
    const dispatch = pro.dispatchReplicationRecovered({
      replica: REPLICA_ADDR,
      reason: 'caught_up',
      gapBytes: 0,
      message: 'caught up',
      timestamp: 0,
      instance: { host: '10.0.0.1', port: 6379 },
      connectionId: PRIMARY,
    });
    pro.endReplicationStall(PRIMARY, REPLICA_ADDR);
    await dispatch;
  };
  const sent = (webhookId: string) =>
    delivered.filter((d) => d.webhookId === webhookId).map((d) => d.event);

  return {
    pro,
    dispatcher,
    storage,
    getWebhooksByEvent,
    failing,
    retrying,
    attempts,
    license,
    delivered,
    lag,
    divergence,
    recovered,
    sent,
  };
}

describe('one webhook per replica stall', () => {
  it('skips not_acking for a webhook that already got the lag alert', async () => {
    const { lag, divergence, sent } = setup([
      webhook('both', BOTH),
      webhook('divergence-only', [WebhookEventType.REPLICATION_DIVERGENCE]),
    ]);

    await lag(30);
    await divergence();

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_LAG]);
    expect(sent('divergence-only')).toEqual([WebhookEventType.REPLICATION_DIVERGENCE]);
  });

  it('skips the lag alert for a webhook that already got not_acking, for the whole episode', async () => {
    const { lag, divergence, sent } = setup([
      webhook('both', BOTH, 120),
      webhook('lag-only', [WebhookEventType.REPLICATION_LAG], 120),
    ]);

    await divergence();
    await lag(150);
    await lag(160);

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_DIVERGENCE]);
    expect(sent('lag-only')).toEqual([WebhookEventType.REPLICATION_LAG]);
  });

  it('sends the lag alert to a webhook that subscribed to divergence after not_acking', async () => {
    const late = webhook('late', [WebhookEventType.REPLICATION_LAG], 120);
    const { lag, divergence, sent } = setup([late]);

    await divergence();
    late.events = BOTH;
    await lag(150);

    expect(sent('late')).toEqual([WebhookEventType.REPLICATION_LAG]);
  });

  it('keeps the lag alert silent after the stall ends mid-episode', async () => {
    const { lag, divergence, recovered, sent } = setup([
      webhook('both', [...BOTH, WebhookEventType.REPLICATION_RECOVERED], 120),
    ]);

    await divergence();
    await lag(150);
    await recovered();
    await lag(150);

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_RECOVERED,
    ]);
  });

  it('still sends a later not_acking when the lag alert was skipped', async () => {
    const { lag, divergence, recovered, sent } = setup([
      webhook('both', [...BOTH, WebhookEventType.REPLICATION_RECOVERED], 120),
    ]);

    await divergence();
    await lag(150);
    await recovered();
    await divergence();

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_RECOVERED,
      WebhookEventType.REPLICATION_DIVERGENCE,
    ]);
  });

  it('sends one alert for a lag-first stall after a skipped lag episode ends', async () => {
    const { lag, divergence, recovered, sent } = setup([
      webhook('both', [...BOTH, WebhookEventType.REPLICATION_RECOVERED], 120),
    ]);

    await divergence();
    await lag(150);
    await recovered();
    await lag(1);
    await lag(150);
    await divergence();

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_RECOVERED,
      WebhookEventType.REPLICATION_LAG,
    ]);
  });

  it('alerts again on a new stall after both recover', async () => {
    const { lag, divergence, recovered, sent } = setup([webhook('both', BOTH)]);

    await lag(30);
    await divergence();
    await recovered();
    await lag(1);
    await divergence();

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.REPLICATION_DIVERGENCE,
    ]);
  });

  it('sends not_acking as before when the replica is not monitored', async () => {
    const { divergence, sent } = setup([webhook('both', BOTH)], { pairReplica: false });

    await divergence();

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_DIVERGENCE]);
  });

  it('does not dedupe other divergence reasons', async () => {
    const { lag, divergence, sent } = setup([webhook('both', BOTH)]);

    await lag(30);
    await divergence('growth');

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.REPLICATION_DIVERGENCE,
    ]);
  });

  it('stops skipping the lag alert once the primary connection is removed', async () => {
    const { pro, lag, divergence, sent } = setup([webhook('both', BOTH, 120)]);

    await divergence();
    pro.forgetReplication(PRIMARY);
    await lag(150);

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_LAG,
    ]);
  });

  it('sends not_acking to a webhook that dropped replication.lag after its lag alert', async () => {
    const hook = webhook('both', BOTH);
    const { lag, divergence, sent } = setup([hook]);

    await lag(30);
    hook.events = [WebhookEventType.REPLICATION_DIVERGENCE];
    await divergence();

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.REPLICATION_DIVERGENCE,
    ]);
  });

  it('sends the lag alert when the not_acking delivery failed', async () => {
    const { lag, divergence, failing, sent } = setup([webhook('both', BOTH, 120)]);

    failing.add('both');
    await divergence();
    failing.delete('both');
    await lag(150);

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_LAG]);
  });

  it('sends not_acking when the lag alert delivery failed', async () => {
    const { lag, divergence, failing, sent } = setup([webhook('both', BOTH)]);

    failing.add('both');
    await lag(30);
    failing.delete('both');
    await divergence();

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_DIVERGENCE]);
  });

  it('keeps the exclusion when the webhook lookup fails and the event is retried', async () => {
    const { dispatcher, getWebhooksByEvent, lag, divergence, sent } = setup([
      webhook('both', BOTH),
      webhook('divergence-only', [WebhookEventType.REPLICATION_DIVERGENCE]),
    ]);

    await lag(30);
    getWebhooksByEvent.mockRejectedValueOnce(new Error('storage down'));
    await divergence();
    expect(dispatcher.getStorageRetryBufferStats().bufferedEvents).toBe(1);

    await (dispatcher as unknown as { drainStorageRetryBuffer(): Promise<void> })
      .drainStorageRetryBuffer();
    dispatcher.onModuleDestroy();

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_LAG]);
    expect(sent('divergence-only')).toEqual([WebhookEventType.REPLICATION_DIVERGENCE]);
  });

  it('sends the lag alert to a webhook that dropped divergence after not_acking', async () => {
    const hook = webhook('both', BOTH, 120);
    const { lag, divergence, sent } = setup([hook]);

    await divergence();
    hook.events = [WebhookEventType.REPLICATION_LAG];
    await lag(150);

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_LAG,
    ]);
  });

  it('sends a critical escalation after a skipped not_acking', async () => {
    const { lag, divergence, delivered } = setup([webhook('both', BOTH)]);

    await lag(30);
    await divergence('not_acking', 'warning');
    await divergence('not_acking', 'critical');

    expect(delivered).toEqual([
      { event: WebhookEventType.REPLICATION_LAG, webhookId: 'both', level: undefined },
      { event: WebhookEventType.REPLICATION_DIVERGENCE, webhookId: 'both', level: 'critical' },
    ]);
  });

  it('sends a not_acking escalation of a stall that opened with another reason', async () => {
    const { lag, divergence, sent } = setup([webhook('both', BOTH)]);

    await divergence('growth');
    await lag(30);
    await divergence('not_acking', 'critical');

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.REPLICATION_DIVERGENCE,
    ]);
  });

  it('sends a new stall while the lag alert stays latched', async () => {
    const { lag, divergence, recovered, sent } = setup([webhook('both', BOTH)]);

    await lag(30);
    await divergence();
    await recovered();
    await lag(30);
    await divergence();

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.REPLICATION_DIVERGENCE,
    ]);
  });

  it('skips replication.recovered for a webhook whose not_acking was skipped', async () => {
    const { lag, divergence, recovered, sent } = setup([
      webhook('both', [...BOTH, WebhookEventType.REPLICATION_RECOVERED]),
      webhook('divergence-only', [
        WebhookEventType.REPLICATION_DIVERGENCE,
        WebhookEventType.REPLICATION_RECOVERED,
      ]),
      webhook('recovered-only', [WebhookEventType.REPLICATION_RECOVERED]),
    ]);

    await lag(30);
    await divergence();
    await recovered();

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_LAG]);
    expect(sent('divergence-only')).toEqual([
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_RECOVERED,
    ]);
    expect(sent('recovered-only')).toEqual([WebhookEventType.REPLICATION_RECOVERED]);
  });

  it('sends replication.recovered after an escalation reached the webhook', async () => {
    const { lag, divergence, recovered, sent } = setup([
      webhook('both', [...BOTH, WebhookEventType.REPLICATION_RECOVERED]),
    ]);

    await lag(30);
    await divergence('not_acking', 'warning');
    await divergence('not_acking', 'critical');
    await recovered();

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.REPLICATION_DIVERGENCE,
      WebhookEventType.REPLICATION_RECOVERED,
    ]);
  });

  it('looks up the targets once and creates no event when every webhook is excluded', async () => {
    const { dispatcher, getWebhooksByEvent, lag, divergence } = setup([webhook('both', BOTH)]);
    const createPendingEvent = jest.spyOn(dispatcher as never, 'createPendingEvent');

    await lag(30);
    createPendingEvent.mockClear();
    getWebhooksByEvent.mockClear();
    await divergence();

    expect(getWebhooksByEvent).toHaveBeenCalledTimes(1);
    expect(createPendingEvent).not.toHaveBeenCalled();
  });

  it('does not pair replicas while PRO is unlicensed', async () => {
    const { license, lag, divergence, sent } = setup([webhook('both', BOTH)], {
      tier: 'community',
    });

    license.tier = 'pro';
    await lag(30);
    await divergence();

    expect(sent('both')).toEqual([
      WebhookEventType.REPLICATION_LAG,
      WebhookEventType.REPLICATION_DIVERGENCE,
    ]);
  });

  it('records a lag alert that succeeds on retry', async () => {
    const { dispatcher, lag, divergence, retrying, attempts, sent } = setup([
      webhook('both', BOTH),
    ]);

    retrying.add('both');
    await lag(30);
    retrying.delete('both');
    const [first] = attempts;
    await dispatcher.sendWebhook(first.hook, first.deliveryId, first.payload);
    await divergence();

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_LAG]);
  });

  it('skips the lag alert when not_acking lands during the lag lookup', async () => {
    const { getWebhooksByEvent, lag, divergence, sent } = setup([webhook('both', BOTH, 120)]);
    let release: () => void = () => undefined;
    const original = getWebhooksByEvent.getMockImplementation()!;
    getWebhooksByEvent.mockImplementationOnce(
      (event) =>
        new Promise((resolve) => {
          release = () => resolve(original(event));
        }),
    );

    const pendingLag = lag(150);
    await divergence();
    release();
    await pendingLag;

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_DIVERGENCE]);
  });

  it('applies the lag exclusion when a buffered lag alert is replayed', async () => {
    const { dispatcher, storage, lag, divergence, retrying, attempts, sent } = setup([
      webhook('both', BOTH, 120),
    ]);

    retrying.add('both');
    await divergence();
    retrying.delete('both');
    storage.createDelivery.mockRejectedValueOnce(new Error('storage down'));
    await lag(150);
    expect(dispatcher.getStorageRetryBufferStats().bufferedEvents).toBe(1);

    const [first] = attempts;
    await dispatcher.sendWebhook(first.hook, first.deliveryId, first.payload);
    await (dispatcher as unknown as { drainStorageRetryBuffer(): Promise<void> })
      .drainStorageRetryBuffer();
    dispatcher.onModuleDestroy();

    expect(sent('both')).toEqual([WebhookEventType.REPLICATION_DIVERGENCE]);
  });
});
