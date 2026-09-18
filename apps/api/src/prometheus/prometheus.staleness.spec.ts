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
    registry.get.mockImplementation((id: string) =>
      id === 'conn-1' ? conn1Client : conn2Client,
    );
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

  it('releases the in-flight entry when an INFO read times out', async () => {
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

    expect(wedged.getInfoParsed).toHaveBeenCalledTimes(2);
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
});
