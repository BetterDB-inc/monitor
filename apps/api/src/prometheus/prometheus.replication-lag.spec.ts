import { ConfigService } from '@nestjs/config';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WebhookEventsProService } from '@proprietary/webhook-pro/webhook-events-pro.service';
import { LicenseService } from '@proprietary/licenses';

const CONNECTION_ID = 'conn-1';
const OTHER_CONNECTION_ID = 'conn-2';
const INSTANCE = { host: '10.0.0.1', port: 6379 };

interface Harness {
  service: PrometheusService;
  fired: string[];
  latched: Set<string>;
}

function buildService(): Harness {
  const fired: string[] = [];
  const latched = new Set<string>();
  const dispatcher = {
    dispatchThresholdAlert: jest.fn(
      async (_type: string, key: string, value: number, threshold: number): Promise<boolean> => {
        if (value <= threshold) {
          latched.delete(key);
          return false;
        }
        if (latched.has(key)) {
          return false;
        }
        latched.add(key);
        fired.push(key);
        return true;
      },
    ),
    clearThresholdAlert: jest.fn((key: string) => {
      latched.delete(key);
    }),
  };
  const license = { getLicenseTier: jest.fn().mockReturnValue('pro') };
  const pro = new WebhookEventsProService(
    dispatcher as unknown as WebhookDispatcherService,
    license as unknown as LicenseService,
  );
  const registry = {
    getConfig: jest.fn().mockReturnValue(INSTANCE),
    getName: jest.fn().mockReturnValue('primary'),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ConnectionRegistry;
  const config = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService;
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
  return { service, fired, latched };
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
  await new Promise((resolve) => setImmediate(resolve));
}

const LAGGING = { role: 'slave', master_link_status: 'up', master_last_io_seconds_ago: '30' };
const LINK_DOWN = { role: 'slave', master_link_status: 'down', master_last_io_seconds_ago: '30' };

describe('PrometheusService replication lag alert', () => {
  it('re-fires after the master link drops and comes back', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    await poll(service, LAGGING);
    expect(fired).toEqual([`replication_lag:${CONNECTION_ID}`]);

    await poll(service, LINK_DOWN);
    await poll(service, LAGGING);
    expect(fired).toEqual([
      `replication_lag:${CONNECTION_ID}`,
      `replication_lag:${CONNECTION_ID}`,
    ]);
  });

  it('keeps one connection latch from suppressing another', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING, CONNECTION_ID);
    await poll(service, LAGGING, OTHER_CONNECTION_ID);

    expect(fired).toEqual([
      `replication_lag:${CONNECTION_ID}`,
      `replication_lag:${OTHER_CONNECTION_ID}`,
    ]);
  });

  it('keeps the latch when the link is up but the lag field is unparsable', async () => {
    const { service, fired } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'slave', master_link_status: 'up', master_last_io_seconds_ago: '' });
    await poll(service, { role: 'slave', master_link_status: 'up' });
    await poll(service, LAGGING);

    expect(fired).toEqual([`replication_lag:${CONNECTION_ID}`]);
  });

  it('keeps the latch when INFO omits the link status', async () => {
    const { service, latched } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'slave' });

    expect(latched.has(`replication_lag:${CONNECTION_ID}`)).toBe(true);
  });

  it('clears the latch when the replica is promoted', async () => {
    const { service, latched } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'master', connected_slaves: '0', master_repl_offset: '0' });

    expect(latched.has(`replication_lag:${CONNECTION_ID}`)).toBe(false);
  });

  it('clears the latch when the node reports an unknown role', async () => {
    const { service, latched } = buildService();

    await poll(service, LAGGING);
    await poll(service, { role: 'sentinel' });

    expect(latched.has(`replication_lag:${CONNECTION_ID}`)).toBe(false);
  });

  it('clears the latch when the connection is removed', async () => {
    const { service, latched } = buildService();

    await poll(service, LAGGING);
    service.cleanupConnectionMetrics(CONNECTION_ID);

    expect(latched.has(`replication_lag:${CONNECTION_ID}`)).toBe(false);
  });
});
