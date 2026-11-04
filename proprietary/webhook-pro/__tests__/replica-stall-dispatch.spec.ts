import { WebhookEventType, type Webhook } from '@betterdb/shared';
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

function setup(hooks: Webhook[], { pairReplica = true } = {}) {
  const dispatcher = new WebhookDispatcherService(
    {} as never,
    {
      getWebhooksByEvent: jest.fn(async (event: WebhookEventType) =>
        hooks.filter((hook) => hook.events.includes(event)),
      ),
    } as never,
    { get: (_key: string, fallback: unknown) => fallback } as never,
  );
  const delivered: Array<{ event: WebhookEventType; webhookId: string }> = [];
  jest.spyOn(dispatcher as never, 'dispatchPendingEvent').mockImplementation((async (
    event: { eventType: WebhookEventType; pendingWebhookIds: Set<string> | null },
    targets?: Webhook[],
  ) => {
    const subscribed = hooks.filter((hook) => hook.events.includes(event.eventType));
    const ids = targets
      ? targets.map((hook) => hook.id)
      : subscribed
          .map((hook) => hook.id)
          .filter((id) => !event.pendingWebhookIds || event.pendingWebhookIds.has(id));
    ids.forEach((webhookId) => delivered.push({ event: event.eventType, webhookId }));
    return true;
  }) as never);

  const pro = new WebhookEventsProService(dispatcher, { getLicenseTier: () => 'pro' } as never);
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
  const divergence = (reason: 'not_acking' | 'growth' = 'not_acking') =>
    pro.dispatchReplicationDivergence({
      replica: REPLICA_ADDR,
      level: 'warning',
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
  const recovered = () =>
    pro.dispatchReplicationRecovered({
      replica: REPLICA_ADDR,
      reason: 'caught_up',
      gapBytes: 0,
      message: 'caught up',
      timestamp: 0,
      instance: { host: '10.0.0.1', port: 6379 },
      connectionId: PRIMARY,
    });
  const sent = (webhookId: string) =>
    delivered.filter((d) => d.webhookId === webhookId).map((d) => d.event);

  return { pro, lag, divergence, recovered, sent };
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
});
