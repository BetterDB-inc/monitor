import { ConfigService } from '@nestjs/config';
import { WebhookEventType, type Webhook } from '@betterdb/shared';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WebhookEventsProService } from '@proprietary/webhook-pro/webhook-events-pro.service';

const CONNECTION_ID = 'conn-1';
const OTHER_CONNECTION_ID = 'conn-2';
const INSTANCE = { host: '10.0.0.1', port: 6379 };

function webhook(id: string): Webhook {
  return {
    id,
    name: id,
    url: `https://hooks.example.com/${id}`,
    enabled: true,
    events: [WebhookEventType.REPLICATION_LAG],
    retryPolicy: { maxRetries: 0, backoffMultiplier: 2, initialDelayMs: 1, maxDelayMs: 1 },
    thresholds: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

interface Harness {
  service: PrometheusService;
  fired: string[];
}

function buildService(): Harness {
  const config = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService;
  const dispatcher = new WebhookDispatcherService(
    {} as never,
    { getWebhooksByEvent: jest.fn().mockResolvedValue([webhook('wh-1'), webhook('wh-2')]) } as never,
    config,
  );
  const fired: string[] = [];
  jest
    .spyOn(dispatcher as never, 'dispatchPendingEvent')
    .mockImplementation((async (event: { connectionId?: string }, targets?: Webhook[]) => {
      fired.push(`${event.connectionId}:${targets?.[0]?.id}`);
      return true;
    }) as never);
  const pro = new WebhookEventsProService(dispatcher, { getLicenseTier: () => 'pro' } as never);
  const registry = {
    getConfig: jest.fn().mockReturnValue(INSTANCE),
    getName: jest.fn().mockReturnValue('primary'),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ConnectionRegistry;
  const service = new PrometheusService(
    {} as StoragePort,
    registry,
    config,
    {} as RuntimeCapabilityTracker,
    {} as SlowLogAnalyticsService,
    {} as CommandLogAnalyticsService,
    {} as HealthService,
    undefined,
    pro,
  );
  return { service, fired };
}

async function poll(
  service: PrometheusService,
  replication: Record<string, string>,
  connectionId = CONNECTION_ID,
): Promise<void> {
  service['updateReplicationMetrics'](
    { replication } as never,
    'primary',
    connectionId,
    INSTANCE,
    false,
  );
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const LAGGING = { role: 'slave', master_link_status: 'up', master_last_io_seconds_ago: '30' };
const LINK_DOWN = { role: 'slave', master_link_status: 'down', master_last_io_seconds_ago: '30' };
const FIRED_ONCE = [`${CONNECTION_ID}:wh-1`, `${CONNECTION_ID}:wh-2`];
const FIRED_TWICE = [...FIRED_ONCE, ...FIRED_ONCE];

describe('PrometheusService replication lag alert', () => {
  it('re-fires after the master link drops and comes back', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    await poll(service, LAGGING);
    expect(fired).toEqual(FIRED_ONCE);

    await poll(service, LINK_DOWN);
    await poll(service, LAGGING);
    expect(fired).toEqual(FIRED_TWICE);
  });

  it('keeps one connection latch from suppressing another', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING, CONNECTION_ID);
    await poll(service, LAGGING, OTHER_CONNECTION_ID);
    await poll(service, LINK_DOWN, OTHER_CONNECTION_ID);
    await poll(service, LAGGING, CONNECTION_ID);

    expect(fired).toEqual([...FIRED_ONCE, `${OTHER_CONNECTION_ID}:wh-1`, `${OTHER_CONNECTION_ID}:wh-2`]);
  });

  it('keeps the latch when the link is up but the lag field is unparsable', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'slave', master_link_status: 'up', master_last_io_seconds_ago: '' });
    await poll(service, { role: 'slave', master_link_status: 'up' });
    await poll(service, LAGGING);

    expect(fired).toEqual(FIRED_ONCE);
  });

  it('keeps the latch when INFO omits the link status', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'slave' });
    await poll(service, LAGGING);

    expect(fired).toEqual(FIRED_ONCE);
  });

  it('re-arms the alert when the replica is promoted', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'master', connected_slaves: '0', master_repl_offset: '0' });
    await poll(service, LAGGING);

    expect(fired).toEqual(FIRED_TWICE);
  });

  it('re-arms the alert when the node reports an unknown role', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'sentinel' });
    await poll(service, LAGGING);

    expect(fired).toEqual(FIRED_TWICE);
  });

  it('re-arms the alert when the connection is removed', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    service.cleanupConnectionMetrics(CONNECTION_ID);
    await poll(service, LAGGING);

    expect(fired).toEqual(FIRED_TWICE);
  });
});
