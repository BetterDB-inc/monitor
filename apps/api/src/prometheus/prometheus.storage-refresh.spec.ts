import { ConfigService } from '@nestjs/config';
import { ClientAnalyticsStats } from '@betterdb/shared';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { ClientAnalyticsRollupService } from '../client-analytics/client-analytics-rollup.service';
import { AuditStatsCacheService } from '../audit/audit-stats-cache.service';

const LABEL = '10.0.0.1:6379';
const POLL_INTERVAL_MS = 5000;
const BOUND_MS = POLL_INTERVAL_MS * 3;

/**
 * The storage phase (ACL / client / key analytics / forecast / CVE gauges)
 * runs outside the INFO in-flight entry, so a slow storage read can neither
 * delay the next INFO nor trip betterdb_poll_stale, and the scrape never
 * aggregates client_snapshots or the ACL table itself.
 */
describe('PrometheusService storage refresh split', () => {
  let service: PrometheusService;
  let getInfoParsed: jest.Mock;
  let storageCalls: string[];
  let latestStats: ClientAnalyticsStats | null;
  let auditCache: AuditStatsCacheService;
  let getHealth: jest.Mock;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let registry: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    getInfoParsed = jest.fn().mockResolvedValue({ server: { uptime_in_seconds: '42' } });
    registry = {
      getConfig: jest.fn((id: string) => (id === 'conn-1' ? { host: '10.0.0.1', port: 6379 } : null)),
      get: jest.fn().mockReturnValue({ getInfoParsed }),
      list: jest.fn().mockReturnValue([
        { id: 'conn-1', name: 'conn-1', host: '10.0.0.1', port: 6379, isConnected: true },
      ]),
      getDefaultId: jest.fn().mockReturnValue('conn-1'),
    };
    const values: Record<string, unknown> = { PROMETHEUS_POLL_INTERVAL_MS: POLL_INTERVAL_MS };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    } as unknown as ConfigService;
    // Every storage method resolves null and is recorded by name.
    storageCalls = [];
    const storage = new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (prop === 'then') return undefined;
          return (..._args: unknown[]) => {
            storageCalls.push(prop);
            return Promise.resolve(null);
          };
        },
      },
    ) as StoragePort;
    latestStats = null;
    auditCache = new AuditStatsCacheService();
    getHealth = jest.fn().mockResolvedValue(undefined);

    service = new PrometheusService(
      storage,
      registry as unknown as ConnectionRegistry,
      config,
      { isAvailable: jest.fn().mockReturnValue(true), recordFailure: jest.fn() } as unknown as RuntimeCapabilityTracker,
      { getCachedAnalysis: jest.fn().mockReturnValue(null) } as unknown as SlowLogAnalyticsService,
      { hasCommandLogSupport: jest.fn().mockReturnValue(false) } as unknown as CommandLogAnalyticsService,
      { getHealth } as unknown as HealthService,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { getLatestStats: jest.fn(() => latestStats) } as unknown as ClientAnalyticsRollupService,
      auditCache,
    );
    error = jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    warn = jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    service['stop']();
    jest.useRealTimers();
  });

  const ctx = {
    connectionId: 'conn-1',
    connectionName: 'conn-1',
    client: {} as never,
    host: '10.0.0.1',
    port: 6379,
  };

  function hangStoragePhase(ms?: number): jest.SpyInstance {
    return jest.spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never).mockImplementation(
      (() =>
        new Promise<void>((resolve) => {
          if (ms !== undefined) setTimeout(resolve, ms);
        })) as never,
    );
  }

  it('a storage phase slower than the staleness bound neither delays INFO nor marks the connection stale', async () => {
    const storagePhase = hangStoragePhase(BOUND_MS * 4);

    service['start']();
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 8);
    service['stop']();
    registry.list.mockReturnValue([]);

    const text = await service.getMetrics();

    // One INFO per tick (the initial one plus eight scheduled), never held back by storage.
    expect(getInfoParsed.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 0`);
    expect(text).toContain(`betterdb_uptime_in_seconds{connection="${LABEL}"} 42`);
    // The slow refresh was joined, not restarted, while it ran.
    expect(storagePhase.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('serves the scrape while a storage refresh is still pending', async () => {
    hangStoragePhase();

    let settled = false;
    const scrape = service.getMetrics().then((text) => {
      settled = true;
      return text;
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(await scrape).toContain(`betterdb_uptime_in_seconds{connection="${LABEL}"} 42`);
    expect(service['storageRefreshInFlight'].size).toBe(1);
  });

  it('coalesces storage refreshes instead of stacking them', async () => {
    let release: () => void = () => undefined;
    const storagePhase = jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockImplementation((() => new Promise<void>((resolve) => (release = resolve))) as never);

    for (let i = 0; i < 4; i++) {
      await service['updateMetricsForConnection']('conn-1');
    }
    expect(getInfoParsed).toHaveBeenCalledTimes(4);
    expect(storagePhase).toHaveBeenCalledTimes(1);

    release();
    await service.flushStorageRefreshes();
    await service['updateMetricsForConnection']('conn-1');
    expect(storagePhase).toHaveBeenCalledTimes(2);
  });

  it('bounds the tick wait on storage, warns once, and does not take the failure path', async () => {
    const storagePhase = hangStoragePhase();

    const first = service['pollConnection'](ctx);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await expect(first).resolves.toBeUndefined();

    const second = service['pollConnection'](ctx);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await expect(second).resolves.toBeUndefined();

    expect(storagePhase).toHaveBeenCalledTimes(1);
    const storageWarnings = warn.mock.calls.filter(([m]) => String(m).includes('Storage-based metrics refresh'));
    expect(storageWarnings).toHaveLength(1);
    expect(String(storageWarnings[0][0])).toContain('conn-1');
    // Health was pinged once per tick on the success path; INFO stays fresh.
    expect(getHealth).toHaveBeenCalledTimes(2);
    expect(service['freshness'].isStale('conn-1', Date.now())).toBe(false);
  });

  it('a full scrape never calls getClientAnalyticsStats or getAuditStats', async () => {
    latestStats = {
      currentConnections: 3,
      peakConnections: 5,
      peakTimestamp: 1,
      uniqueClientNames: 1,
      uniqueUsers: 1,
      uniqueIps: 1,
      connectionsByName: { api: { current: 3, peak: 5, avgAge: 10 } },
      connectionsByUser: { app: { current: 3, peak: 5 } },
      connectionsByUserAndName: {},
      timeRange: { earliest: 0, latest: 1 },
    };
    auditCache.set('conn-1', { totalEntries: 2, entriesByReason: { auth: 2 }, entriesByUser: { bob: 2 } } as never);

    await service.getMetrics();
    await service.flushStorageRefreshes();
    jest.advanceTimersByTime(POLL_INTERVAL_MS);
    await service.getMetrics();
    await service.flushStorageRefreshes();

    expect(storageCalls).not.toContain('getClientAnalyticsStats');
    expect(storageCalls).not.toContain('getAuditStats');
  });

  it('exports no client or ACL series, and does not fail, before the caches are populated', async () => {
    await service.getMetrics();
    await service.flushStorageRefreshes();
    const text = await service.getMetrics();

    expect(text).not.toMatch(/^betterdb_client_connections_\w+\{/m);
    expect(text).not.toMatch(/^betterdb_acl_denied\w*\{/m);
    const relevantErrors = error.mock.calls.filter(([m]) => /ACL|client analytics/i.test(String(m)));
    expect(relevantErrors).toEqual([]);
  });

  it('exports client gauges matching the aggregator latest stats', async () => {
    latestStats = {
      currentConnections: 7,
      peakConnections: 11,
      peakTimestamp: 123,
      uniqueClientNames: 2,
      uniqueUsers: 2,
      uniqueIps: 3,
      connectionsByName: {
        api: { current: 4, peak: 6, avgAge: 1 },
        worker: { current: 0, peak: 5, avgAge: 2 },
      },
      connectionsByUser: { app: { current: 7, peak: 11 }, admin: { current: 0, peak: 1 } },
      connectionsByUserAndName: {},
      timeRange: { earliest: 1, latest: 2 },
    };
    auditCache.set('conn-1', { totalEntries: 9, entriesByReason: { auth: 9 }, entriesByUser: { bob: 9 } } as never);

    await service.getMetrics();
    await service.flushStorageRefreshes();
    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_client_connections_current{connection="${LABEL}"} 7`);
    expect(text).toContain(`betterdb_client_connections_peak{connection="${LABEL}"} 11`);
    expect(text).toContain(`betterdb_client_connections_by_name{connection="${LABEL}",client_name="api"} 4`);
    expect(text).toContain(`betterdb_client_connections_by_name{connection="${LABEL}",client_name="worker"} 0`);
    expect(text).toContain(`betterdb_client_connections_by_user{connection="${LABEL}",user="app"} 7`);
    expect(text).toContain(`betterdb_acl_denied{connection="${LABEL}"} 9`);
    expect(text).toContain(`betterdb_acl_denied_by_reason{connection="${LABEL}",reason="auth"} 9`);
  });
});
