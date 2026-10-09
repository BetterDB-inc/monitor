import { ConfigService } from '@nestjs/config';
import { WebhookEventType } from '@betterdb/shared';
import { PrometheusService } from './prometheus.service';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { RuntimeCapabilityTracker } from '../connections/runtime-capability-tracker.service';
import { SlowLogAnalyticsService } from '../slowlog-analytics/slowlog-analytics.service';
import { CommandLogAnalyticsService } from '../commandlog-analytics/commandlog-analytics.service';
import { HealthService } from '../health/health.service';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { OtelEventDispatcherService } from '../otel-telemetry/otel-event-dispatcher.service';
import type { InfoResponse } from '../common/types/metrics.types';

const T0 = 1_700_000_000_000;
const POLL_INTERVAL_MS = 5000;
const WRITE_EVENTS: string[] = [WebhookEventType.WRITES_REJECTED, WebhookEventType.WRITES_RECOVERED];

const HEALTHY = { rdb_last_bgsave_status: 'ok', aof_last_write_status: 'ok' };
const BGSAVE_FAILED = { rdb_last_bgsave_status: 'err', aof_last_write_status: 'ok' };

function info(
  persistence: Record<string, string>,
  errorstats: Record<string, number> = {},
): InfoResponse {
  return {
    persistence: persistence as unknown as InfoResponse['persistence'],
    errorstats: Object.fromEntries(
      Object.entries(errorstats).map(([code, count]) => [`errorstat_${code}`, { count }]),
    ),
  };
}

describe('PrometheusService write-rejection wiring', () => {
  let service: PrometheusService;
  let dispatchEvent: jest.Mock;
  let otelDispatch: jest.Mock;
  let getSlowLogLength: jest.Mock;
  let infoReads: Record<string, jest.Mock>;

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });

    const configs: Record<string, { host: string; port: number; connectionType?: string }> = {
      'conn-a': { host: '10.0.0.1', port: 6379 },
      'conn-b': { host: '10.0.0.2', port: 6379 },
      'ext-1': { host: 'cache.internal', port: 6379, connectionType: 'external' },
    };
    infoReads = {
      'conn-a': jest.fn(),
      'conn-b': jest.fn(),
      'ext-1': jest.fn(),
    };
    const registry = {
      getConfig: jest.fn((id: string) => configs[id] ?? null),
      get: jest.fn((id: string) =>
        infoReads[id] ? { getInfoParsed: infoReads[id], getClusterInfo: jest.fn() } : undefined,
      ),
      list: jest.fn(() => []),
    } as unknown as ConnectionRegistry;
    const config = {
      get: jest.fn((key: string, fallback?: unknown) =>
        key === 'PROMETHEUS_POLL_INTERVAL_MS' ? POLL_INTERVAL_MS : fallback,
      ),
    } as unknown as ConfigService;

    dispatchEvent = jest.fn().mockResolvedValue(true);
    otelDispatch = jest.fn();
    getSlowLogLength = jest.fn().mockResolvedValue(0);

    service = new PrometheusService(
      {} as StoragePort,
      registry,
      config,
      {
        isAvailable: jest.fn().mockReturnValue(true),
      } as unknown as RuntimeCapabilityTracker,
      {
        getSlowLogLength,
        getLastSeenId: jest.fn().mockReturnValue(null),
      } as unknown as SlowLogAnalyticsService,
      {} as CommandLogAnalyticsService,
      {} as HealthService,
      {
        dispatchEvent,
        dispatchThresholdAlertPerWebhook: jest.fn().mockResolvedValue(undefined),
      } as unknown as WebhookDispatcherService,
      undefined,
      undefined,
      undefined,
      { dispatch: otelDispatch } as unknown as OtelEventDispatcherService,
    );
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'log').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(service['logger'], 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function poll(connectionId: string, reply: InfoResponse): Promise<void> {
    jest.setSystemTime(Date.now() + POLL_INTERVAL_MS);
    infoReads[connectionId].mockResolvedValueOnce(reply);
    await service['runUpdateMetricsForConnection'](connectionId);
  }

  function writeEvents(connectionId?: string): Array<[string, Record<string, unknown>, string]> {
    return dispatchEvent.mock.calls.filter(
      ([event, , id]) =>
        WRITE_EVENTS.includes(event) && (connectionId === undefined || id === connectionId),
    );
  }

  it('dispatches nothing for a healthy poll', async () => {
    await poll('conn-a', info(HEALTHY, { MISCONF: 0, OOM: 0 }));
    await poll('conn-a', info(HEALTHY, { MISCONF: 0, OOM: 0 }));

    expect(writeEvents()).toHaveLength(0);
    expect(otelDispatch).not.toHaveBeenCalled();
  });

  it('dispatches writes.rejected once when BGSAVE fails and does not repeat while it stays failed', async () => {
    await poll('conn-a', info(HEALTHY));
    await poll('conn-a', info(BGSAVE_FAILED));
    await poll('conn-a', info(BGSAVE_FAILED));

    const events = writeEvents('conn-a');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(WebhookEventType.WRITES_REJECTED);
    expect(events[0][1]).toMatchObject({
      causes: ['rdb_bgsave_failed'],
      severity: 'warning',
      instance: { host: '10.0.0.1', port: 6379 },
    });
    expect(otelDispatch).toHaveBeenCalledTimes(1);
    expect(otelDispatch).toHaveBeenCalledWith(
      WebhookEventType.WRITES_REJECTED,
      expect.objectContaining({ causes: ['rdb_bgsave_failed'] }),
      'conn-a',
    );
  });

  it('dispatches writes.recovered once when persistence is healthy again', async () => {
    await poll('conn-a', info(BGSAVE_FAILED));
    await poll('conn-a', info(HEALTHY));
    await poll('conn-a', info(HEALTHY));

    const events = writeEvents('conn-a');
    expect(events.map(([event]) => event)).toEqual([
      WebhookEventType.WRITES_REJECTED,
      WebhookEventType.WRITES_RECOVERED,
    ]);
    expect(events[1][1]).toMatchObject({ rejectingForMs: POLL_INTERVAL_MS });
  });

  it('dispatches a critical writes.rejected when errorstat_OOM rises on a later poll', async () => {
    await poll('conn-a', info(HEALTHY, { OOM: 4 }));
    await poll('conn-a', info(HEALTHY, { OOM: 4 }));
    expect(writeEvents()).toHaveLength(0);

    await poll('conn-a', info(HEALTHY, { OOM: 90 }));

    const events = writeEvents('conn-a');
    expect(events).toHaveLength(1);
    expect(events[0][0]).toBe(WebhookEventType.WRITES_REJECTED);
    expect(events[0][1]).toMatchObject({
      causes: ['maxmemory_reached'],
      severity: 'critical',
      rejectedSinceLastPoll: { OOM: 86 },
    });
  });

  it('re-sends writes.rejected once, flagged escalated, when clients start receiving MISCONF', async () => {
    await poll('conn-a', info(HEALTHY, { MISCONF: 0 }));
    await poll('conn-a', info(BGSAVE_FAILED, { MISCONF: 0 }));
    await poll('conn-a', info(BGSAVE_FAILED, { MISCONF: 40 }));
    await poll('conn-a', info(BGSAVE_FAILED, { MISCONF: 95 }));

    const events = writeEvents('conn-a');
    expect(events.map(([event]) => event)).toEqual([
      WebhookEventType.WRITES_REJECTED,
      WebhookEventType.WRITES_REJECTED,
    ]);
    expect(events[0][1]).toMatchObject({ severity: 'warning' });
    expect(events[0][1]).not.toHaveProperty('escalated');
    expect(events[1][1]).toMatchObject({
      severity: 'critical',
      escalated: true,
      causes: ['rdb_bgsave_failed'],
      rejectedSinceLastPoll: { MISCONF: 40 },
      rejectingForMs: POLL_INTERVAL_MS,
    });
    expect(otelDispatch).toHaveBeenCalledTimes(2);
    expect(otelDispatch.mock.calls[1]).toEqual([
      WebhookEventType.WRITES_REJECTED,
      expect.objectContaining({ severity: 'critical', escalated: true }),
      'conn-a',
    ]);
  });

  it('never dispatches for an external connection', async () => {
    await poll('ext-1', info(HEALTHY, { OOM: 0 }));
    await poll('ext-1', info(BGSAVE_FAILED, { OOM: 50 }));
    await poll('ext-1', info(HEALTHY, { OOM: 50 }));

    expect(writeEvents()).toHaveLength(0);
    expect(otelDispatch).not.toHaveBeenCalled();
  });

  it('keeps per-connection state: only the failing connection fires', async () => {
    await poll('conn-a', info(HEALTHY));
    await poll('conn-b', info(HEALTHY));
    await poll('conn-a', info(BGSAVE_FAILED));
    await poll('conn-b', info(HEALTHY));
    await poll('conn-a', info(HEALTHY));
    await poll('conn-b', info(HEALTHY));

    expect(writeEvents('conn-a').map(([event]) => event)).toEqual([
      WebhookEventType.WRITES_REJECTED,
      WebhookEventType.WRITES_RECOVERED,
    ]);
    expect(writeEvents('conn-b')).toHaveLength(0);
  });

  it('keeps polling when the OTLP mirror throws', async () => {
    otelDispatch.mockImplementation(() => {
      throw new Error('exporter down');
    });

    await poll('conn-a', info(BGSAVE_FAILED));

    expect(otelDispatch).toHaveBeenCalledTimes(1);
    expect(writeEvents('conn-a')).toHaveLength(1);
    // The slowlog stage runs after INFO metrics; reaching it means the pass completed.
    expect(getSlowLogLength).toHaveBeenCalledWith('conn-a');
  });
});
