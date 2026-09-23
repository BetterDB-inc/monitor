import { ConfigService } from '@nestjs/config';
import { collectDefaultMetrics, Gauge } from 'prom-client';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';

const LABEL = '10.0.0.1:6379';
const OTHER_LABEL = '10.0.0.2:6379';
const POLL_INTERVAL_MS = 5000;
const BOUND_MS = POLL_INTERVAL_MS * 3;

describe('PrometheusService staleness bounds', () => {
  let service: PrometheusService;
  let getInfoParsed: jest.Mock;
  let configs: Record<string, { host: string; port: number }>;

  beforeEach(() => {
    jest.useFakeTimers({ now: 1_000_000 });
    getInfoParsed = jest.fn().mockResolvedValue({});
    configs = {
      'conn-1': { host: '10.0.0.1', port: 6379 },
      'conn-2': { host: '10.0.0.2', port: 6379 },
      'conn-3': { host: '10.0.0.1', port: 6379 },
    };
    const registry = {
      getConfig: jest.fn((id: string) => configs[id] ?? null),
      get: jest.fn().mockReturnValue({ getInfoParsed }),
      list: jest.fn().mockReturnValue([]),
      getDefaultId: jest.fn().mockReturnValue('conn-1'),
    } as unknown as ConnectionRegistry;
    const values: Record<string, unknown> = { PROMETHEUS_POLL_INTERVAL_MS: POLL_INTERVAL_MS };
    const config = {
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    } as unknown as ConfigService;

    service = new PrometheusService(
      {} as StoragePort,
      registry,
      config,
      {} as RuntimeCapabilityTracker,
      {} as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
    );
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setMemory(label: string, value: number): void {
    service['memoryUsedBytes'].labels(label).set(value);
  }

  async function update(connectionId: string): Promise<void> {
    await service['runUpdateMetricsForConnection'](connectionId);
  }

  it('keeps series and reports not-stale for a fresh connection', async () => {
    await update('conn-1');
    setMemory(LABEL, 100);

    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_memory_used_bytes{connection="${LABEL}"} 100`);
    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 0`);
  });

  it('drops gauge series once INFO has failed past the bound', async () => {
    await update('conn-1');
    setMemory(LABEL, 100);
    service.incrementPollCounter('conn-1');

    getInfoParsed.mockRejectedValue(new Error('connection lost'));
    jest.advanceTimersByTime(BOUND_MS + 1);
    await update('conn-1');

    const text = await service.getMetrics();

    expect(text).not.toContain(`betterdb_memory_used_bytes{connection="${LABEL}"}`);
    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 1`);
    expect(text).toContain(`betterdb_polls_total{connection="${LABEL}"} 1`);
  });

  it('drops series for a connection that was never polled again', async () => {
    await update('conn-1');
    setMemory(LABEL, 100);

    jest.advanceTimersByTime(BOUND_MS + 1);

    const text = await service.getMetrics();

    expect(text).not.toContain(`betterdb_memory_used_bytes{connection="${LABEL}"}`);
  });

  it('marks a never-successful connection stale after the bound', async () => {
    getInfoParsed.mockRejectedValue(new Error('auth failed'));
    await update('conn-1');
    jest.advanceTimersByTime(BOUND_MS + 1);
    await update('conn-1');

    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 1`);
  });

  it('clears the stale flag on recovery', async () => {
    await update('conn-1');
    jest.advanceTimersByTime(BOUND_MS + 1);
    await service.getMetrics();

    await update('conn-1');
    setMemory(LABEL, 200);
    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 0`);
    expect(text).toContain(`betterdb_memory_used_bytes{connection="${LABEL}"} 200`);
  });

  it('applies the same sweep to the OTel mirror snapshot', async () => {
    await update('conn-1');
    await update('conn-2');
    setMemory(LABEL, 100);
    setMemory(OTHER_LABEL, 300);

    jest.advanceTimersByTime(BOUND_MS + 1);
    await update('conn-2');

    const snapshot = await service.collectMetricsAsJson();
    const memory = snapshot.find((m) => m.name === 'betterdb_memory_used_bytes');

    expect(memory?.values.map((v) => v.labels.connection)).toEqual([OTHER_LABEL]);
  });

  it('keeps a shared label while another connection with it is fresh', async () => {
    await update('conn-1');
    await update('conn-3');
    setMemory(LABEL, 100);

    jest.advanceTimersByTime(BOUND_MS + 1);
    await update('conn-3');

    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_memory_used_bytes{connection="${LABEL}"} 100`);
    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 0`);
  });

  it('removes every gauge series for a removed connection', async () => {
    await update('conn-1');
    setMemory(LABEL, 100);
    await service.getMetrics();

    service.cleanupConnectionMetrics('conn-1');
    await jest.runAllTimersAsync();

    const text = await service.getMetrics();

    expect(text).not.toContain(`connection="${LABEL}"`);
  });

  it('skips storage-based metrics while stale', async () => {
    const acl = jest
      .spyOn(service as never, 'updateAclMetrics' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'updateClientMetrics' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'updateSlowlogMetrics' as never)
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(service as never, 'updateCommandlogMetrics' as never)
      .mockResolvedValue(undefined as never);

    await update('conn-1');
    await service['updateStorageBasedMetricsForConnection']('conn-1');
    expect(acl).toHaveBeenCalledTimes(1);

    getInfoParsed.mockRejectedValue(new Error('connection lost'));
    jest.advanceTimersByTime(BOUND_MS + 1);
    await update('conn-1');
    await service['updateStorageBasedMetricsForConnection']('conn-1');

    expect(acl).toHaveBeenCalledTimes(1);
  });

  it('does not read unlabelled default-metric gauges when sweeping stale series', async () => {
    collectDefaultMetrics({ register: service['registry'], prefix: 'betterdb_' });
    const lagGauge = service['registry'].getSingleMetric(
      'betterdb_nodejs_eventloop_lag_seconds',
    ) as Gauge;
    const getSpy = jest.spyOn(lagGauge, 'get');

    await update('conn-1');
    jest.advanceTimersByTime(BOUND_MS + 1);

    await service['sweepStaleSeries']();

    expect(getSpy).not.toHaveBeenCalled();
  });

  it('bounds the INFO update per connection so one hung connection cannot stall another', async () => {
    const conn1Client = { getInfoParsed: jest.fn().mockReturnValue(new Promise(() => {})) };
    const conn2Client = { getInfoParsed: jest.fn().mockResolvedValue({}) };
    const registryGet = service['connectionRegistry'].get as jest.Mock;
    registryGet.mockImplementation((id: string) => {
      if (id === 'conn-1') return conn1Client;
      if (id === 'conn-2') return conn2Client;
      return { getInfoParsed };
    });
    (service as unknown as Record<string, unknown>)['healthService'] = {
      getHealth: jest.fn().mockResolvedValue(undefined),
    };
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    const ctx1 = {
      connectionId: 'conn-1',
      connectionName: 'conn-1',
      client: conn1Client as never,
      host: '10.0.0.1',
      port: 6379,
    };
    const ctx2 = {
      connectionId: 'conn-2',
      connectionName: 'conn-2',
      client: conn2Client as never,
      host: '10.0.0.2',
      port: 6379,
    };
    const pollBoth = () =>
      Promise.allSettled([service['pollConnection'](ctx1), service['pollConnection'](ctx2)]);

    const firstRound = pollBoth();
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await firstRound;

    setMemory(OTHER_LABEL, 300);

    const secondRound = pollBoth();
    await jest.advanceTimersByTimeAsync(BOUND_MS - POLL_INTERVAL_MS + 1);
    await secondRound;

    const snapshot = await service.collectMetricsAsJson();
    const pollStale = snapshot.find((m) => m.name === 'betterdb_poll_stale');
    const staleFor = (label: string) =>
      pollStale?.values.find((v) => v.labels.connection === label)?.value;

    expect(staleFor(LABEL)).toBe(1);
    expect(staleFor(OTHER_LABEL)).toBe(0);

    const memory = snapshot.find((m) => m.name === 'betterdb_memory_used_bytes');
    expect(memory?.values.map((v) => v.labels.connection)).toEqual([OTHER_LABEL]);
  });

  it('bounds the scrape-path INFO refresh so one hung connection cannot hang the endpoint', async () => {
    const conn1Client = { getInfoParsed: jest.fn().mockReturnValue(new Promise(() => {})) };
    const conn2Client = { getInfoParsed: jest.fn().mockResolvedValue({}) };
    const registry = service['connectionRegistry'] as unknown as Record<string, jest.Mock>;
    registry.get.mockImplementation((id: string) => (id === 'conn-1' ? conn1Client : conn2Client));
    registry.list.mockReturnValue([
      { id: 'conn-1', name: 'conn-1', isConnected: true },
      { id: 'conn-2', name: 'conn-2', isConnected: true },
    ]);
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    const scrape = async (): Promise<string> => {
      const pending = service.getMetrics();
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
      return pending;
    };

    await scrape();
    await scrape();
    setMemory(OTHER_LABEL, 300);
    const text = await scrape();

    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 1`);
    expect(text).toContain(`betterdb_poll_stale{connection="${OTHER_LABEL}"} 0`);
    expect(text).toContain(`betterdb_memory_used_bytes{connection="${OTHER_LABEL}"} 300`);
    expect(conn2Client.getInfoParsed).toHaveBeenCalledTimes(3);
  });

  it('keeps the scrape within one bound no matter how many connections are wedged', async () => {
    const wedged = { getInfoParsed: jest.fn().mockReturnValue(new Promise(() => {})) };
    const registry = service['connectionRegistry'] as unknown as Record<string, jest.Mock>;
    registry.get.mockReturnValue(wedged);
    registry.list.mockReturnValue([
      { id: 'conn-1', name: 'conn-1', isConnected: true },
      { id: 'conn-2', name: 'conn-2', isConnected: true },
      { id: 'conn-3', name: 'conn-3', isConnected: true },
    ]);
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    let settled = false;
    const pending = service.getMetrics().then((text) => {
      settled = true;
      return text;
    });
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);

    expect(settled).toBe(true);
    await pending;
    expect(wedged.getInfoParsed).toHaveBeenCalledTimes(3);
  });

  it('does not issue another INFO while one is still outstanding', async () => {
    const wedged = { getInfoParsed: jest.fn().mockReturnValue(new Promise(() => {})) };
    const registry = service['connectionRegistry'] as unknown as Record<string, jest.Mock>;
    registry.get.mockReturnValue(wedged);
    registry.list.mockReturnValue([{ id: 'conn-1', name: 'conn-1', isConnected: true }]);
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    const scrape = async (): Promise<void> => {
      const pending = service.getMetrics();
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
      await pending;
    };

    await scrape();
    await scrape();

    expect(wedged.getInfoParsed).toHaveBeenCalledTimes(1);
  });

  it('bounds the health ping so a wedged health check cannot block the tick', async () => {
    const client = { getInfoParsed: jest.fn().mockResolvedValue({}) };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(client);
    const getHealth = jest.fn().mockReturnValue(new Promise(() => {}));
    (service as unknown as Record<string, unknown>)['healthService'] = { getHealth };
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    let settled = false;
    const poll = service['pollConnection']({
      connectionId: 'conn-1',
      connectionName: 'conn-1',
      client: client as never,
      host: '10.0.0.1',
      port: 6379,
    } as never).then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);

    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(settled).toBe(true);
    await poll;
  });

  it('keeps a whole poll tick inside one interval when INFO uses the budget', async () => {
    const wedged = { getInfoParsed: jest.fn().mockReturnValue(new Promise(() => {})) };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(wedged);
    const getHealth = jest.fn().mockReturnValue(new Promise(() => {}));
    (service as unknown as Record<string, unknown>)['healthService'] = { getHealth };
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    let settledAt: number | undefined;
    const poll = service['pollConnection']({
      connectionId: 'conn-1',
      connectionName: 'conn-1',
      client: wedged as never,
      host: '10.0.0.1',
      port: 6379,
    } as never).catch(() => {
      settledAt = Date.now();
    });
    const startedAt = Date.now();
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await poll;

    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(settledAt).toBeDefined();
    expect((settledAt as number) - startedAt).toBeLessThanOrEqual(POLL_INTERVAL_MS + 1);
  });

  it('drops a late INFO reply for a connection that was removed mid-read', async () => {
    let resolveInfo: (info: unknown) => void = () => undefined;
    const slow = {
      getInfoParsed: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
      ),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(slow);

    const pass = service['runUpdateMetricsForConnection']('conn-1');
    service.cleanupConnectionMetrics('conn-1');
    resolveInfo({ server: { uptime_in_seconds: '42' } });
    await pass;
    await jest.runAllTimersAsync();

    const text = await service.getMetrics();

    expect(text).not.toContain(`connection="${LABEL}"`);
  });

  it('applies a late INFO reply when no newer pass has started', async () => {
    let resolveInfo: (info: unknown) => void = () => undefined;
    const slow = {
      getInfoParsed: jest.fn().mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
      ),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(slow);

    const abandoned = service['updateMetricsForConnection']('conn-1').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await abandoned;

    await jest.advanceTimersByTimeAsync(BOUND_MS - POLL_INTERVAL_MS - 1000);
    resolveInfo({ server: { uptime_in_seconds: '42' } });
    await jest.advanceTimersByTimeAsync(2000);

    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_uptime_in_seconds{connection="${LABEL}"} 42`);
    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 0`);
  });

  it('writes a shared late reply only from the newest pass', async () => {
    let resolveInfo: (info: unknown) => void = () => undefined;
    const slow = {
      getInfoParsed: jest.fn().mockReturnValueOnce(
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
      ),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(slow);
    const serverWrites = jest.spyOn(service as never, 'updateServerMetrics' as never);

    const abandoned = service['updateMetricsForConnection']('conn-1').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await abandoned;

    const newer = service['updateMetricsForConnection']('conn-1');
    resolveInfo({ server: { uptime_in_seconds: '42' } });
    await newer;

    expect(slow.getInfoParsed).toHaveBeenCalledTimes(1);
    expect(serverWrites).toHaveBeenCalledTimes(1);
  });
  it('keeps gauges current when INFO is slower than the poll interval on every pass', async () => {
    const slow = {
      getInfoParsed: jest.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ server: { uptime_in_seconds: '42' } }),
              POLL_INTERVAL_MS + 2000,
            );
          }),
      ),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(slow);

    for (let pass = 0; pass < 6; pass++) {
      void service['updateMetricsForConnection']('conn-1').catch(() => undefined);
      await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }

    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_uptime_in_seconds{connection="${LABEL}"} 42`);
    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 0`);
    expect(slow.getInfoParsed).toHaveBeenCalledTimes(3);
  });

  it('keeps a node fresh under the real poller when INFO is slower than the interval', async () => {
    const slow = {
      getInfoParsed: jest.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ server: { uptime_in_seconds: '42' } }),
              POLL_INTERVAL_MS + 2000,
            );
          }),
      ),
    };
    const registry = service['connectionRegistry'] as unknown as Record<string, jest.Mock>;
    registry.get.mockReturnValue(slow);
    registry.list.mockReturnValue([
      { id: 'conn-1', name: 'conn-1', host: '10.0.0.1', port: 6379, isConnected: true },
    ]);
    (service as unknown as Record<string, unknown>)['healthService'] = {
      getHealth: jest.fn().mockReturnValue(new Promise(() => {})),
    };
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    service['start']();
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 8);
    service['stop']();
    registry.list.mockReturnValue([]);

    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_uptime_in_seconds{connection="${LABEL}"} 42`);
    expect(text).toContain(`betterdb_poll_stale{connection="${LABEL}"} 0`);
  });

  it('issues a fresh INFO once the outstanding one has settled', async () => {
    let resolveFirst: (info: unknown) => void = () => undefined;
    const client = {
      getInfoParsed: jest
        .fn()
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
        )
        .mockResolvedValue({ server: { uptime_in_seconds: '43' } }),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(client);

    const abandoned = service['updateMetricsForConnection']('conn-1').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await abandoned;
    resolveFirst({ server: { uptime_in_seconds: '42' } });
    await Promise.resolve();

    await service['updateMetricsForConnection']('conn-1');

    const text = await service.getMetrics();

    expect(client.getInfoParsed).toHaveBeenCalledTimes(2);
    expect(text).toContain(`betterdb_uptime_in_seconds{connection="${LABEL}"} 43`);
  });

  it('keeps a later pass alive when an earlier one times out behind it', async () => {
    let resolveSecond: (info: unknown) => void = () => undefined;
    const client = {
      getInfoParsed: jest
        .fn()
        .mockReturnValueOnce(new Promise(() => {}))
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
        ),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(client);

    const abandoned = service['updateMetricsForConnection']('conn-1').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 2000);

    service.cleanupConnectionMetrics('conn-1');
    const current = service['updateMetricsForConnection']('conn-1');

    await jest.advanceTimersByTimeAsync(2001);
    await abandoned;

    resolveSecond({ server: { uptime_in_seconds: '42' } });
    await current;

    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_uptime_in_seconds{connection="${LABEL}"} 42`);
  });

  it('drops cluster writes for a connection removed mid CLUSTER INFO', async () => {
    let resolveCluster: (info: unknown) => void = () => undefined;
    const client = {
      getInfoParsed: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: '1' } }),
      getClusterInfo: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveCluster = resolve;
        }),
      ),
      getClusterNodes: jest.fn().mockResolvedValue([]),
      getCapabilities: jest.fn().mockReturnValue({ hasClusterSlotStats: false }),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(client);
    (service as unknown as Record<string, unknown>)['runtimeCapabilityTracker'] = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordFailure: jest.fn(),
    };

    const pass = service['runUpdateMetricsForConnection']('conn-1');
    await jest.advanceTimersByTimeAsync(1);

    service.cleanupConnectionMetrics('conn-1');
    resolveCluster({ cluster_state: 'ok', cluster_known_nodes: '3', cluster_size: '3' });
    await pass;
    await jest.runAllTimersAsync();

    const text = await service.getMetrics();

    expect(client.getClusterInfo).toHaveBeenCalledTimes(1);
    expect(text).not.toContain(`betterdb_cluster_known_nodes{connection="${LABEL}"}`);
  });

  it('skips the storage pass for a connection removed during its INFO pass', async () => {
    const getAuditStats = jest
      .fn()
      .mockResolvedValue({ totalEntries: 7, entriesByReason: {}, entriesByUser: {} });
    (service as unknown as Record<string, unknown>)['storage'] = { getAuditStats };

    await update('conn-1');
    const epoch = service['currentEpoch']('conn-1');
    service.cleanupConnectionMetrics('conn-1');

    await service['updateStorageBasedMetricsForConnection']('conn-1', epoch);
    await jest.runAllTimersAsync();

    const text = await service.getMetrics();

    expect(getAuditStats).not.toHaveBeenCalled();
    expect(text).not.toContain(`betterdb_acl_denied_total{connection="${LABEL}"}`);
  });

  it('does not page twice when a pass is abandoned mid failover dispatch', async () => {
    const clusterInfo = {
      cluster_state: 'ok',
      cluster_slots_fail: '0',
      cluster_slots_assigned: '16384',
      cluster_known_nodes: '3',
      cluster_size: '3',
    };
    const client = {
      getInfoParsed: jest.fn().mockResolvedValue({ cluster: { cluster_enabled: '1' } }),
      getClusterInfo: jest.fn(async () => clusterInfo),
      getClusterNodes: jest.fn().mockResolvedValue([]),
      getCapabilities: jest.fn().mockReturnValue({ hasClusterSlotStats: false }),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(client);
    (service as unknown as Record<string, unknown>)['runtimeCapabilityTracker'] = {
      isAvailable: jest.fn().mockReturnValue(true),
      recordFailure: jest.fn(),
    };
    const dispatchClusterFailover = jest.fn().mockReturnValue(new Promise(() => {}));
    (service as unknown as Record<string, unknown>)['webhookEventsProService'] = {
      dispatchClusterFailover,
    };

    await update('conn-1');

    clusterInfo.cluster_state = 'fail';
    const abandoned = service['updateMetricsForConnection']('conn-1').catch(() => undefined);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await abandoned;

    await update('conn-1');

    expect(dispatchClusterFailover).toHaveBeenCalledTimes(1);
  });

  it('sweeps a series a late write recreated after removal', async () => {
    await update('conn-1');
    setMemory(LABEL, 100);
    service.cleanupConnectionMetrics('conn-1');
    await jest.advanceTimersByTimeAsync(0);

    setMemory(LABEL, 400);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    const text = await service.getMetrics();

    expect(text).not.toContain(`betterdb_memory_used_bytes{connection="${LABEL}"}`);
  });

  it('coalesces health checks so a timed-out check cannot overlap the next one', async () => {
    const client = { getInfoParsed: jest.fn().mockResolvedValue({}) };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValue(client);
    let resolveHealth: () => void = () => undefined;
    const getHealth = jest.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveHealth = () => resolve();
      }),
    );
    (service as unknown as Record<string, unknown>)['healthService'] = { getHealth };
    jest
      .spyOn(service as never, 'updateStorageBasedMetricsForConnection' as never)
      .mockResolvedValue(undefined as never);

    const ctx = {
      connectionId: 'conn-1',
      connectionName: 'conn-1',
      client: client as never,
      host: '10.0.0.1',
      port: 6379,
    } as never;

    const first = service['pollConnection'](ctx);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await first;

    const second = service['pollConnection'](ctx);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await second;

    expect(getHealth).toHaveBeenCalledTimes(1);

    resolveHealth();
    await jest.advanceTimersByTimeAsync(1);

    const third = service['pollConnection'](ctx);
    await jest.advanceTimersByTimeAsync(POLL_INTERVAL_MS + 1);
    await third;

    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it('keeps series a connection re-added under the same label wrote during cleanup', async () => {
    await update('conn-1');
    setMemory(LABEL, 100);
    service['freshness'].forget('conn-1');

    const gauge = service['memoryUsedBytes'];
    const readSnapshot = gauge.get.bind(gauge);
    jest.spyOn(gauge, 'get').mockImplementationOnce(async () => {
      await update('conn-3');
      setMemory(LABEL, 250);
      return readSnapshot();
    });

    await service['removeSeriesForLabels'](new Set([LABEL]), new Set<string>());
    const text = await service.getMetrics();

    expect(text).toContain(`betterdb_memory_used_bytes{connection="${LABEL}"} 250`);
  });

  it('does not refresh a reused connection ID with the old label', async () => {
    let resolveInfo: (info: unknown) => void = () => undefined;
    const slow = {
      getInfoParsed: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveInfo = resolve;
        }),
      ),
    };
    (service['connectionRegistry'].get as jest.Mock).mockReturnValueOnce(slow);

    const pass = service['runUpdateMetricsForConnection']('conn-1');
    service['cleanupConnectionMetrics']('conn-1');
    configs['conn-1'] = { host: '10.0.0.9', port: 6379 };
    await update('conn-1');

    jest.advanceTimersByTime(BOUND_MS + 1);
    resolveInfo({});
    await pass;

    const { stale, fresh } = service['freshness'].labelsByFreshness(Date.now());

    expect([...fresh]).toEqual([]);
    expect([...stale]).toEqual(['10.0.0.9:6379']);
  });
});
