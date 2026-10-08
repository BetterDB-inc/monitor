import type { OtlpKeyValue, OtlpMetric } from '@app/external-metrics/otlp-metrics-types';
import { KvCacheOtlpSinkService } from '../kv-cache-otlp-sink.service';

const NOW = 1_700_000_000_000;

const str = (key: string, value: string): OtlpKeyValue => ({ key, value: { stringValue: value } });
const attrs = { 'betterdb.lmcache.engine': 'otlp-1' };

const point = (worker: string, value: number | null) => ({
  attributes: [str('model_name', 'llama'), str('worker_id', worker), str('role', 'worker')],
  startTimeUnixNano: String(BigInt(NOW - 60_000) * 1_000_000n),
  ...(value === null ? {} : { asInt: String(value) }),
});

const sum = (name: string, points: ReturnType<typeof point>[], temporality: number | string = 2): OtlpMetric => ({
  name,
  sum: { dataPoints: points, aggregationTemporality: temporality },
});

function setup(opts: { engine?: unknown; licensed?: boolean } = {}) {
  const engine = 'engine' in opts ? opts.engine : { id: 'e1', connectionId: 'c1', enabled: true };
  const registry = { byOtlpId: jest.fn().mockReturnValue(engine), recordResult: jest.fn() };
  const samples = { observe: jest.fn().mockReturnValue(true) };
  const license = { hasFeature: jest.fn().mockReturnValue(opts.licensed ?? true) };
  const service = new KvCacheOtlpSinkService(registry as any, samples as any, license as any);
  return { registry, samples, license, service };
}

describe('KvCacheOtlpSinkService', () => {
  it('drops every point as unknown_engine for an unknown id', () => {
    const { service, samples } = setup({ engine: null });
    const metrics = [sum('lmcache:num_hit_tokens_total', [point('0', 1), point('1', 2)])];
    expect(service.ingest(attrs, metrics, NOW)).toEqual({ accepted: 0, dropped: { unknown_engine: 2 } });
    expect(samples.observe).not.toHaveBeenCalled();
  });

  it('drops every point as unknown_engine when the attribute is missing', () => {
    const { service, registry } = setup();
    const metrics = [sum('lmcache:num_hit_tokens_total', [point('0', 1)])];
    expect(service.ingest({}, metrics, NOW)).toEqual({ accepted: 0, dropped: { unknown_engine: 1 } });
    expect(registry.byOtlpId).not.toHaveBeenCalled();
  });

  it('drops every point as unknown_engine for a disabled engine', () => {
    const { service } = setup({ engine: { id: 'e1', connectionId: 'c1', enabled: false } });
    const metrics = [sum('lmcache:num_hit_tokens_total', [point('0', 1)])];
    expect(service.ingest(attrs, metrics, NOW).dropped).toEqual({ unknown_engine: 1 });
  });

  it('drops every point as unknown_engine when unlicensed', () => {
    const { service, samples } = setup({ licensed: false });
    const metrics = [sum('lmcache:num_hit_tokens_total', [point('0', 1), point('1', 2)])];
    expect(service.ingest(attrs, metrics, NOW)).toEqual({ accepted: 0, dropped: { unknown_engine: 2 } });
    expect(samples.observe).not.toHaveBeenCalled();
  });

  it('observes each data point of a cumulative sum', () => {
    const { service, samples, registry } = setup();
    const metrics = [sum('lmcache:num_hit_tokens_total', [point('0', 10), point('1', 20)])];
    const result = service.ingest(attrs, metrics, NOW);
    expect(result).toEqual({ accepted: 2, dropped: {} });
    expect(samples.observe).toHaveBeenCalledTimes(2);
    expect(samples.observe).toHaveBeenNthCalledWith(
      1,
      {
        engineId: 'e1',
        connectionId: 'c1',
        modelName: 'llama',
        series: '0|worker',
        metric: 'num_hit_tokens',
        value: 10,
        cumulative: true,
        startMs: NOW - 60_000,
      },
      NOW,
    );
    expect(samples.observe.mock.calls[1][0]).toMatchObject({ series: '1|worker', value: 20 });
    expect(registry.recordResult).toHaveBeenCalledWith('e1', { lastSeenAt: NOW, lastError: null });
  });

  it('marks delta temporality sums as not cumulative', () => {
    const { service, samples } = setup();
    service.ingest(attrs, [sum('lmcache:num_hit_tokens_total', [point('0', 3)], 1)], NOW);
    expect(samples.observe.mock.calls[0][0].cumulative).toBe(false);
    service.ingest(attrs, [sum('lmcache:num_hit_tokens_total', [point('0', 3)], 'AGGREGATION_TEMPORALITY_DELTA')], NOW);
    expect(samples.observe.mock.calls[1][0].cumulative).toBe(false);
  });

  it('classifies unsupported, unmapped and invalid points', () => {
    const { service, samples, registry } = setup();
    const gauge: OtlpMetric = { name: 'lmcache:lookup_hit_rate', gauge: { dataPoints: [point('0', 1)] } };
    const metrics = [
      gauge,
      sum('lmcache:something_else', [point('0', 1), point('1', 1)]),
      sum('lmcache:toString_total', [point('0', 1)]),
      sum('lmcache:num_hit_tokens_total', [point('0', null)]),
    ];
    const result = service.ingest(attrs, metrics, NOW);
    expect(result).toEqual({
      accepted: 0,
      dropped: { unsupported_type: 1, unmapped_metric: 3, invalid_value: 1 },
    });
    expect(samples.observe).not.toHaveBeenCalled();
    expect(registry.recordResult).not.toHaveBeenCalled();
  });
});
