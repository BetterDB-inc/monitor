import { Logger } from '@nestjs/common';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { ExternalMetricsStore } from '../external-metrics-store';
import { OtelMetricsIngestService, toPartialSuccess } from '../otel-metrics-ingest.service';
import type { OtlpKeyValue, OtlpMetric, OtlpMetricsRequest } from '../otlp-metrics-types';

const NOW_MS = 1_700_000_000_000;
const NOW_NS = String(BigInt(NOW_MS) * 1_000_000n);

const str = (key: string, value: string): OtlpKeyValue => ({ key, value: { stringValue: value } });

function resource(attrs: OtlpKeyValue[], metrics: OtlpMetric[]): OtlpMetricsRequest {
  return { resourceMetrics: [{ resource: { attributes: attrs }, scopeMetrics: [{ metrics }] }] };
}

const identity = [str('server.address', 'cache.internal'), { key: 'server.port', value: { intValue: '6379' } }];

function gauge(name: string, value: number, attrs: OtlpKeyValue[] = [], ...ts: [string?]): OtlpMetric {
  const timeUnixNano = ts.length > 0 ? ts[0] : NOW_NS;
  return { name, gauge: { dataPoints: [{ attributes: attrs, timeUnixNano, asInt: String(value) }] } };
}

function build(match: { id: string; connectionType: 'direct' | 'external' } | null = { id: 'ext', connectionType: 'external' }) {
  const registry = { findByHostPort: jest.fn().mockReturnValue(match) } as unknown as ConnectionRegistry;
  const store = new ExternalMetricsStore();
  return { service: new OtelMetricsIngestService(registry, store), store, registry };
}

describe('OtelMetricsIngestService', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('applies mapped points to the matched external connection', () => {
    const { service, store, registry } = build();
    const result = service.ingest(
      resource(identity, [
        gauge('redis.memory.used', 1024),
        gauge('redis.cpu.time', 3, [str('state', 'user')]),
        gauge('redis.db.keys', 5, [str('db', '0')]),
      ]),
      NOW_MS,
    );
    expect(registry.findByHostPort).toHaveBeenCalledWith('cache.internal', 6379);
    expect(result.accepted).toBe(3);
    expect(toPartialSuccess(result)).toBeNull();
    expect(store.snapshot('ext', NOW_MS)).toEqual({
      memory: { used_memory: '1024' },
      cpu: { used_cpu_user: '3' },
      keyspace: { db0: 'keys=5' },
    });
    expect(store.latestVersion('ext')).toBe(NOW_MS);
  });

  it('drops every point of an unidentified resource', () => {
    const { service } = build();
    const result = service.ingest(resource([], [gauge('redis.memory.used', 1), gauge('redis.uptime', 2)]), NOW_MS);
    expect(result.dropped.unidentified).toBe(2);
    expect(result.accepted).toBe(0);
  });

  it('drops unknown and already-polled instances', () => {
    expect(build(null).service.ingest(resource(identity, [gauge('redis.uptime', 1)]), NOW_MS).dropped.unknown_instance).toBe(1);
    expect(
      build({ id: 'd', connectionType: 'direct' }).service.ingest(resource(identity, [gauge('redis.uptime', 1)]), NOW_MS)
        .dropped.already_polled,
    ).toBe(1);
  });

  it('counts unsupported types, delta sums and unmapped metrics', () => {
    const { service } = build();
    const result = service.ingest(
      resource(identity, [
        { name: 'redis.cmd.latency', histogram: { dataPoints: [{}, {}] } },
        { name: 'x.summary', summary: { dataPoints: [{}] } },
        { name: 'x.exp', exponentialHistogram: { dataPoints: [{}] } },
        { name: 'redis.keys.expired', sum: { aggregationTemporality: 1, dataPoints: [{ timeUnixNano: NOW_NS, asInt: '1' }] } },
        { name: 'redis.keys.evicted', sum: { aggregationTemporality: 'AGGREGATION_TEMPORALITY_DELTA', dataPoints: [{ asInt: '1' }] } },
        gauge('redis.cluster.state', 1),
        { name: 'redis.memory.used', gauge: { dataPoints: [{ timeUnixNano: NOW_NS }] } },
      ]),
      NOW_MS,
    );
    expect(result.dropped).toEqual({
      unidentified: 0,
      unknown_instance: 0,
      already_polled: 0,
      unsupported_type: 4,
      unsupported_temporality: 2,
      unmapped_metric: 2,
    });
    expect(toPartialSuccess(result)).toEqual({
      rejectedDataPoints: 8,
      errorMessage: 'unsupported_type=4 unsupported_temporality=2 unmapped_metric=2',
    });
  });

  it('accepts cumulative sums and skips role points whose value is 0', () => {
    const { service, store } = build();
    const result = service.ingest(
      resource(identity, [
        { name: 'redis.commands.processed', sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ timeUnixNano: NOW_NS, asInt: '9' }] } },
        {
          name: 'redis.role',
          sum: {
            aggregationTemporality: 2,
            dataPoints: [
              { attributes: [str('role', 'primary')], timeUnixNano: NOW_NS, asInt: '1' },
              { attributes: [str('role', 'replica')], timeUnixNano: NOW_NS, asInt: '0' },
            ],
          },
        },
      ]),
      NOW_MS,
    );
    expect(toPartialSuccess(result)).toBeNull();
    expect(store.snapshot('ext', NOW_MS)).toEqual({
      stats: { total_commands_processed: '9' },
      replication: { role: 'master' },
    });
  });

  it('uses the receive time for points without a timestamp', () => {
    const { service, store } = build();
    service.ingest(resource(identity, [gauge('redis.uptime', 5, [], undefined)]), NOW_MS + 7);
    expect(store.latestVersion('ext')).toBe(NOW_MS + 7);
  });

  it('records the server version and the valkey flag', () => {
    const redis = build();
    redis.service.ingest(resource([...identity, str('redis.version', '7.2.4')], [gauge('redis.uptime', 1)]), NOW_MS);
    expect(redis.store.serverVersion('ext')).toBe('7.2.4');
    expect(redis.store.isValkey('ext')).toBe(false);

    const byMetric = build();
    byMetric.service.ingest(resource(identity, [gauge('valkey.memory.used', 1)]), NOW_MS);
    expect(byMetric.store.isValkey('ext')).toBe(true);

    const byResource = build();
    byResource.service.ingest(resource([...identity, str('db.system.name', 'valkey')], [gauge('redis.uptime', 1)]), NOW_MS);
    expect(byResource.store.isValkey('ext')).toBe(true);
  });

  it('ignores an older point without counting it as dropped', () => {
    const { service, store } = build();
    service.ingest(resource(identity, [gauge('redis.uptime', 9)]), NOW_MS);
    const result = service.ingest(
      resource(identity, [gauge('redis.uptime', 1, [], String(BigInt(NOW_MS - 10) * 1_000_000n))]),
      NOW_MS,
    );
    expect(result.accepted).toBe(0);
    expect(toPartialSuccess(result)).toBeNull();
    expect(store.snapshot('ext', NOW_MS).server).toEqual({ uptime_in_seconds: '9' });
  });

  it('clamps a future-stamped point to the receive time', () => {
    const { service, store } = build();
    const inAnHour = String(BigInt(NOW_MS + 3_600_000) * 1_000_000n);
    service.ingest(resource(identity, [gauge('redis.memory.used', 1, [], inAnHour)]), NOW_MS);
    expect(store.latestVersion('ext')).toBe(NOW_MS);

    const later = NOW_MS + 10_000;
    const result = service.ingest(
      resource(identity, [gauge('redis.memory.used', 2, [], String(BigInt(later) * 1_000_000n))]),
      later,
    );
    expect(result.accepted).toBe(1);
    expect(store.snapshot('ext', later)).toEqual({ memory: { used_memory: '2' } });

    expect(store.isFresh('ext', later + store.staleAfterMs + 1)).toBe(false);
  });

  it('rate-limits warnings per reason and instance to one per five minutes', () => {
    const { service } = build(null);
    const req = resource(identity, [gauge('redis.uptime', 1)]);
    service.ingest(req, NOW_MS);
    service.ingest(req, NOW_MS + 60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    service.ingest(req, NOW_MS + 5 * 60_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('handles an empty request', () => {
    const { service } = build();
    expect(toPartialSuccess(service.ingest({}, NOW_MS))).toBeNull();
  });
});
