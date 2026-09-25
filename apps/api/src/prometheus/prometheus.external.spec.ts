import { ConfigService } from '@nestjs/config';
import { IWebhookEventsEnterpriseService, WebhookEventType } from '@betterdb/shared';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { ExternalMetricsStore } from '../external-metrics/external-metrics-store';
import { ExternalMetricsAdapter } from '../external-metrics/external-metrics.adapter';
import type { InfoTarget } from '../external-metrics/otlp-metrics-types';

const T0 = 1_700_000_000_000;
const EXT_LABEL = 'cache.internal:6379';
const DIRECT_LABEL = '10.0.0.1:6379';
const POLL_INTERVAL_MS = 5000;
const BOUND_MS = POLL_INTERVAL_MS * 3;

function series(name: string, label: string): RegExp {
  return new RegExp(
    `^betterdb_${name}\\{connection="${label.replace(/\./g, '\\.')}"[^}]*\\} (\\S+)$`,
    'm',
  );
}

function anySeries(prefix: string, label: string): RegExp {
  return new RegExp(
    `^betterdb_${prefix}[a-z_]*\\{connection="${label.replace(/\./g, '\\.')}"`,
    'm',
  );
}

describe('PrometheusService external connections', () => {
  let service: PrometheusService;
  let store: ExternalMetricsStore;
  let adapter: ExternalMetricsAdapter;
  let dispatchThresholdAlertPerWebhook: jest.Mock;
  let dispatchComplianceAlert: jest.Mock;
  let directInfo: jest.Mock;
  let includeDirect: boolean;
  let runtimeCapabilityTracker: { isAvailable: jest.Mock; recordFailure: jest.Mock };
  let slowLogAnalytics: {
    getCachedAnalysis: jest.Mock;
    getSlowLogLength: jest.Mock;
    getLastSeenId: jest.Mock;
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    store = new ExternalMetricsStore();
    adapter = new ExternalMetricsAdapter('ext-1', store);
    directInfo = jest.fn().mockResolvedValue({
      memory: { used_memory: '500' },
      clients: { connected_clients: '2' },
    });
    includeDirect = false;

    const configs: Record<string, { host: string; port: number; connectionType?: string }> = {
      'ext-1': { host: 'cache.internal', port: 6379, connectionType: 'external' },
      'direct-1': { host: '10.0.0.1', port: 6379 },
    };
    const clients: Record<string, unknown> = {
      'ext-1': adapter,
      'direct-1': { getInfoParsed: directInfo, getClusterInfo: jest.fn() },
    };
    const registry = {
      getConfig: jest.fn((id: string) => configs[id] ?? null),
      get: jest.fn((id: string) => clients[id]),
      list: jest.fn(() => [
        {
          id: 'ext-1',
          name: 'pushed',
          host: 'cache.internal',
          port: 6379,
          isConnected: adapter.isConnected(),
          connectionType: 'external',
        },
        ...(includeDirect
          ? [
              {
                id: 'direct-1',
                name: 'polled',
                host: '10.0.0.1',
                port: 6379,
                isConnected: true,
                connectionType: 'direct',
              },
            ]
          : []),
      ]),
      getDefaultId: jest.fn().mockReturnValue('ext-1'),
    } as unknown as ConnectionRegistry;
    const values: Record<string, unknown> = { PROMETHEUS_POLL_INTERVAL_MS: POLL_INTERVAL_MS };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    } as unknown as ConfigService;
    dispatchThresholdAlertPerWebhook = jest.fn().mockResolvedValue(undefined);
    dispatchComplianceAlert = jest.fn().mockResolvedValue(false);
    const storage = {
      getAuditStats: jest.fn().mockResolvedValue({
        totalEntries: 0,
        entriesByReason: {},
        entriesByUser: {},
      }),
      getClientAnalyticsStats: jest.fn().mockResolvedValue({
        currentConnections: 0,
        peakConnections: 0,
        connectionsByName: {},
        connectionsByUser: {},
      }),
      getCveScanResult: jest.fn().mockResolvedValue(null),
    };
    runtimeCapabilityTracker = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordFailure: jest.fn().mockReturnValue(false),
    };
    slowLogAnalytics = {
      getCachedAnalysis: jest.fn().mockReturnValue(null),
      getSlowLogLength: jest.fn().mockResolvedValue(7),
      getLastSeenId: jest.fn().mockReturnValue(3),
    };

    service = new PrometheusService(
      storage as unknown as StoragePort,
      registry,
      config,
      runtimeCapabilityTracker as unknown as RuntimeCapabilityTracker,
      slowLogAnalytics as unknown as SlowLogAnalyticsService,
      {
        hasCommandLogSupport: jest.fn().mockReturnValue(false),
      } as unknown as CommandLogAnalyticsService,
      { getHealth: jest.fn().mockResolvedValue(undefined) } as unknown as HealthService,
      { dispatchThresholdAlertPerWebhook } as unknown as WebhookDispatcherService,
      undefined,
      { dispatchComplianceAlert } as unknown as IWebhookEventsEnterpriseService,
    );
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function push(fields: Record<string, string>, timeMs = Date.now()): void {
    store.apply(
      'ext-1',
      Object.entries(fields).map(([key, value]) => {
        const [section, field, subkey] = key.split('.');
        const target: InfoTarget =
          subkey === undefined
            ? { kind: 'scalar', section, field }
            : { kind: 'composite', section: section as 'keyspace', field, subkey };
        return { target, value, timeMs };
      }),
    );
  }

  async function pollTick(): Promise<void> {
    await (service as any).tick();
  }

  function registryText(): Promise<string> {
    return service['registry'].metrics();
  }

  function expectNoLiveAnalyticsSeries(text: string): void {
    expect(text).not.toMatch(anySeries('acl_denied', EXT_LABEL));
    expect(text).not.toMatch(anySeries('client_connections_', EXT_LABEL));
  }

  function complianceConnectionIds(): unknown[] {
    return dispatchComplianceAlert.mock.calls.map(([payload]) => payload.connectionId);
  }

  function connectionCriticalCalls(): unknown[][] {
    return dispatchThresholdAlertPerWebhook.mock.calls.filter(
      ([event]) => event === WebhookEventType.CONNECTION_CRITICAL,
    );
  }

  it('opts in to external connections and polls every tick', () => {
    expect((service as any).supportsExternalConnections()).toBe(true);
    expect((service as any).skipUnchangedSamples()).toBe(false);
  });

  describe('poller path', () => {
    it('exports pushed fields and no series for absent ones', async () => {
      push({ 'memory.used_memory': '1024', 'clients.connected_clients': '3' });

      await pollTick();
      const text = await registryText();

      expect(text).toMatch(series('memory_used_bytes', EXT_LABEL));
      expect(text.match(series('memory_used_bytes', EXT_LABEL))?.[1]).toBe('1024');
      expect(text.match(series('connected_clients', EXT_LABEL))?.[1]).toBe('3');
      expect(text).not.toMatch(series('memory_used_rss_bytes', EXT_LABEL));
      expect(text).not.toMatch(series('memory_max_bytes', EXT_LABEL));
      expect(text).not.toMatch(series('blocked_clients', EXT_LABEL));
      expect(text).not.toMatch(series('uptime_in_seconds', EXT_LABEL));
      expect(text).not.toMatch(series('keyspace_hits_total', EXT_LABEL));
      expect(text).not.toMatch(anySeries('cluster_', EXT_LABEL));
      expect(text).not.toMatch(anySeries('slowlog_', EXT_LABEL));
      expectNoLiveAnalyticsSeries(text);
      expect(runtimeCapabilityTracker.isAvailable).not.toHaveBeenCalled();
      expect(slowLogAnalytics.getSlowLogLength).not.toHaveBeenCalled();
    });

    it('removes a series when its field stops being pushed', async () => {
      push({ 'memory.used_memory': '1024', 'memory.used_memory_rss': '2048' });
      await pollTick();
      expect(await registryText()).toMatch(series('memory_used_rss_bytes', EXT_LABEL));

      store.clear('ext-1');
      push({ 'memory.used_memory': '1024' });
      await pollTick();
      const text = await registryText();

      expect(text).not.toMatch(series('memory_used_rss_bytes', EXT_LABEL));
      expect(text.match(series('memory_used_bytes', EXT_LABEL))?.[1]).toBe('1024');
    });

    it('removes a section when none of its fields are pushed any more', async () => {
      push({
        'memory.used_memory': '1024',
        'clients.connected_clients': '3',
        'keyspace.db0.keys': '5',
        'keyspace.db0.expires': '1',
        'keyspace.db0.avg_ttl': '0',
      });
      await pollTick();
      let text = await registryText();
      expect(text).toMatch(series('db_keys', EXT_LABEL));
      expect(text.match(series('keyspace_keys', EXT_LABEL))?.[1]).toBe('5');

      store.clear('ext-1');
      push({ 'clients.connected_clients': '4' });
      await pollTick();
      text = await registryText();

      expect(text).not.toMatch(series('memory_used_bytes', EXT_LABEL));
      expect(text).not.toMatch(series('db_keys', EXT_LABEL));
      expect(text).not.toMatch(series('keyspace_keys', EXT_LABEL));
      expect(text).not.toMatch(series('keyspace_keys_expiring', EXT_LABEL));
      expect(text.match(series('connected_clients', EXT_LABEL))?.[1]).toBe('4');
    });

    describe('replication without a pushed role', () => {
      it('exports the pushed offset and connected slaves', async () => {
        push({ 'replication.master_repl_offset': '4242', 'replication.connected_slaves': '2' });

        await pollTick();
        const text = await registryText();

        expect(text.match(series('replication_offset', EXT_LABEL))?.[1]).toBe('4242');
        expect(text.match(series('connected_slaves', EXT_LABEL))?.[1]).toBe('2');
        expect(text).not.toMatch(series('master_link_up', EXT_LABEL));
        expect(text).not.toMatch(series('master_last_io_seconds_ago', EXT_LABEL));
      });

      it('exports only the fields that were pushed', async () => {
        push({ 'replication.master_repl_offset': '7' });

        await pollTick();
        const text = await registryText();

        expect(text.match(series('replication_offset', EXT_LABEL))?.[1]).toBe('7');
        expect(text).not.toMatch(series('connected_slaves', EXT_LABEL));
      });

      it('removes the series once the fields stop being pushed', async () => {
        push({ 'replication.master_repl_offset': '7', 'replication.connected_slaves': '1' });
        await pollTick();

        store.clear('ext-1');
        push({ 'memory.used_memory': '1' });
        await pollTick();
        const text = await registryText();

        expect(text).not.toMatch(series('replication_offset', EXT_LABEL));
        expect(text).not.toMatch(series('connected_slaves', EXT_LABEL));
      });
    });

    it('does not fire connection_critical without a pushed maxclients', async () => {
      push({ 'clients.connected_clients': '9999' });

      await pollTick();

      expect(connectionCriticalCalls()).toHaveLength(0);
    });

    it('fires connection_critical once maxclients is pushed', async () => {
      push({ 'clients.connected_clients': '90', 'clients.maxclients': '100' });

      await pollTick();

      expect(connectionCriticalCalls()).toHaveLength(1);
      expect(connectionCriticalCalls()[0][2]).toBe(90);
    });

    it('does not fire memory_critical without a pushed maxmemory', async () => {
      push({ 'memory.used_memory': '1024' });

      await pollTick();

      expect(
        dispatchThresholdAlertPerWebhook.mock.calls.filter(
          ([event]) => event === WebhookEventType.MEMORY_CRITICAL,
        ),
      ).toHaveLength(0);
    });

    it('does not raise a compliance alert without a pushed maxmemory_policy', async () => {
      push({ 'memory.used_memory': '900', 'memory.maxmemory': '1000' });

      await pollTick();

      expect(dispatchComplianceAlert).not.toHaveBeenCalled();
    });

    it('raises a compliance alert once maxmemory_policy is present', async () => {
      push({
        'memory.used_memory': '900',
        'memory.maxmemory': '1000',
        'memory.maxmemory_policy': 'noeviction',
      });

      await pollTick();

      expect(complianceConnectionIds()).toEqual(['ext-1']);
    });
  });

  describe('scrape path', () => {
    it('exports external connections from getMetrics', async () => {
      push({ 'memory.used_memory': '1024', 'clients.connected_clients': '3' });

      const text = await service.getMetrics();

      expect(text.match(series('memory_used_bytes', EXT_LABEL))?.[1]).toBe('1024');
      expect(text).not.toMatch(series('memory_used_rss_bytes', EXT_LABEL));
      expect(text).not.toMatch(anySeries('cluster_', EXT_LABEL));
      expect(text).not.toMatch(anySeries('slowlog_', EXT_LABEL));
      expectNoLiveAnalyticsSeries(text);
      expect(connectionCriticalCalls()).toHaveLength(0);
    });

    it('keeps the noeviction compliance default for direct connections only', async () => {
      includeDirect = true;
      directInfo.mockResolvedValue({ memory: { used_memory: '900', maxmemory: '1000' } });
      push({ 'memory.used_memory': '900', 'memory.maxmemory': '1000' });

      const text = await service.getMetrics();

      expect(complianceConnectionIds()).toEqual(['direct-1']);
      expect(text).toMatch(series('acl_denied', DIRECT_LABEL));
      expect(text).toMatch(series('client_connections_current', DIRECT_LABEL));
      expectNoLiveAnalyticsSeries(text);
    });

    it('removes live-only analytics series already exported under the label', async () => {
      service['aclDeniedTotal'].labels(EXT_LABEL).set(4);
      service['clientConnectionsCurrent'].labels(EXT_LABEL).set(2);
      service['clientConnectionsPeak'].labels(EXT_LABEL).set(9);
      push({ 'memory.used_memory': '1024' });

      expectNoLiveAnalyticsSeries(await service.getMetrics());
    });

    it('removes a pushed field once it goes stale in the store', async () => {
      push({ 'memory.used_memory': '1024', 'memory.used_memory_rss': '2048' });
      expect(await service.getMetrics()).toMatch(series('memory_used_rss_bytes', EXT_LABEL));

      jest.advanceTimersByTime(store.staleAfterMs - 1000);
      push({ 'memory.used_memory': '4096' });
      jest.advanceTimersByTime(2000);
      const text = await service.getMetrics();

      expect(text.match(series('memory_used_bytes', EXT_LABEL))?.[1]).toBe('4096');
      expect(text).not.toMatch(series('memory_used_rss_bytes', EXT_LABEL));
    });

    it('stops refreshing and sweeps the connection once every push is stale', async () => {
      push({ 'memory.used_memory': '1024' });
      expect(await service.getMetrics()).toMatch(series('memory_used_bytes', EXT_LABEL));

      jest.advanceTimersByTime(store.staleAfterMs + BOUND_MS + 1);
      expect(adapter.isConnected()).toBe(false);
      const text = await service.getMetrics();

      expect(text).not.toMatch(series('memory_used_bytes', EXT_LABEL));
      expect(text).toMatch(series('poll_stale', EXT_LABEL));
      expect(text.match(series('poll_stale', EXT_LABEL))?.[1]).toBe('1');
    });

    it('keeps zero defaults for direct connections', async () => {
      includeDirect = true;
      push({ 'memory.used_memory': '1024' });

      const text = await service.getMetrics();

      expect(text.match(series('memory_used_bytes', DIRECT_LABEL))?.[1]).toBe('500');
      expect(text.match(series('memory_used_rss_bytes', DIRECT_LABEL))?.[1]).toBe('0');
      expect(text.match(series('blocked_clients', DIRECT_LABEL))?.[1]).toBe('0');
      expect(text).toMatch(series('cluster_enabled', DIRECT_LABEL));
      expect(text).not.toMatch(series('memory_used_rss_bytes', EXT_LABEL));
      expect(connectionCriticalCalls().map((call) => call[6])).toEqual(['direct-1']);
    });
  });
});
