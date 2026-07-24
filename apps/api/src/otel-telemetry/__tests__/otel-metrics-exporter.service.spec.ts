import { ConfigService } from '@nestjs/config';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { OtelMetricsExporterService } from '../otel-metrics-exporter.service';
import type { PrometheusService } from '../../prometheus/prometheus.service';

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, def?: T): T | undefined => (key in values ? (values[key] as T) : def),
  } as unknown as ConfigService;
}

function makePrometheus(snapshot: unknown[] = []): PrometheusService & {
  collectMetricsAsJson: jest.Mock;
} {
  return {
    collectMetricsAsJson: jest.fn().mockResolvedValue(snapshot),
  } as unknown as PrometheusService & { collectMetricsAsJson: jest.Mock };
}

interface ObservedPoint {
  instrument: string;
  value: number;
  attributes: Record<string, string | number>;
}

/**
 * Stands in for a real Meter so tests can drive the collection loop the way
 * PeriodicExportingMetricReader does.
 *
 * Mirrors one load-bearing SDK behaviour: ObservableRegistry captures the
 * callback's instrument set before awaiting it, then records only buffers for
 * instruments in that set. Observations for an instrument registered later are
 * therefore discarded for the cycle in flight — which is exactly why a newly
 * seen family only lands from the next cycle onward.
 */
class FakeMeter {
  callback?: (result: { observe: jest.Mock }) => Promise<void>;
  observedCount = 0;
  readonly options = new Map<string, { description?: string; unit?: string }>();
  private observed: object[] = [];
  private readonly names = new Map<object, string>();

  createObservableGauge(name: string, options?: { description?: string; unit?: string }): object {
    this.options.set(name, options ?? {});
    return this.track(name);
  }

  createObservableCounter(name: string, options?: { description?: string; unit?: string }): object {
    this.options.set(name, options ?? {});
    return this.track(name);
  }

  private track(name: string): object {
    const instrument = { name };
    this.names.set(instrument, name);
    return instrument;
  }

  addBatchObservableCallback(
    callback: (result: { observe: jest.Mock }) => Promise<void>,
    observables: object[],
  ): void {
    this.callback = callback;
    this.observed = [...observables];
    this.observedCount = observables.length;
  }

  removeBatchObservableCallback(): void {
    this.callback = undefined;
    this.observed = [];
    this.observedCount = 0;
  }

  async collect(): Promise<ObservedPoint[]> {
    if (!this.callback) {
      return [];
    }
    const callback = this.callback;
    const recordable = new Set(this.observed);
    const buffered: {
      instrument: object;
      value: number;
      attributes: ObservedPoint['attributes'];
    }[] = [];
    const observe = jest.fn(
      (instrument: object, value: number, attributes: Record<string, string | number>) => {
        buffered.push({ instrument, value, attributes });
      },
    );

    await callback({ observe });

    return buffered
      .filter((entry) => {
        return recordable.has(entry.instrument);
      })
      .map((entry) => {
        return {
          instrument: this.names.get(entry.instrument) ?? 'unknown',
          value: entry.value,
          attributes: entry.attributes,
        };
      });
  }
}

/**
 * Boots the service with the real config path but a fake meter, so the batch
 * callback can be driven directly. The export interval is long enough that the
 * reader never fires on its own during a test.
 */
async function initWithMeter(
  prom: PrometheusService,
  meter: FakeMeter,
): Promise<OtelMetricsExporterService> {
  jest
    .spyOn(MeterProvider.prototype, 'getMeter')
    .mockReturnValue(meter as unknown as ReturnType<MeterProvider['getMeter']>);
  jest.spyOn(MeterProvider.prototype, 'shutdown').mockResolvedValue(undefined);

  const service = new OtelMetricsExporterService(
    makeConfig({
      OTEL_TELEMETRY_ENABLED: true,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_METRICS_EXPORT_INTERVAL_MS: 600000,
    }),
    prom,
  );
  await service.onModuleInit();
  return service;
}

describe('OtelMetricsExporterService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('no-ops when no OTLP endpoint is configured', async () => {
    const prom = makePrometheus();
    const service = new OtelMetricsExporterService(
      makeConfig({ OTEL_TELEMETRY_ENABLED: true }),
      prom,
    );

    await service.onModuleInit();

    expect(prom.collectMetricsAsJson).not.toHaveBeenCalled();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('no-ops when explicitly disabled even with an endpoint', async () => {
    const prom = makePrometheus();
    const service = new OtelMetricsExporterService(
      makeConfig({
        OTEL_TELEMETRY_ENABLED: 'false',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      }),
      prom,
    );

    await service.onModuleInit();

    expect(prom.collectMetricsAsJson).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('reads the registry once to plan instruments when enabled, and shuts down cleanly', async () => {
    const prom = makePrometheus([
      { name: 'betterdb_memory_used_bytes', help: 'mem', type: 'gauge', values: [] },
      { name: 'betterdb_polls_total', help: 'polls', type: 'counter', values: [] },
    ]);
    const service = new OtelMetricsExporterService(
      makeConfig({
        OTEL_TELEMETRY_ENABLED: true,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
        OTEL_METRICS_EXPORT_INTERVAL_MS: 600000,
      }),
      prom,
    );

    await service.onModuleInit();

    expect(prom.collectMetricsAsJson).toHaveBeenCalledTimes(1);
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });

  it('observes a data point per label set on each collection', async () => {
    const prom = makePrometheus([
      {
        name: 'betterdb_memory_used_bytes',
        help: 'mem',
        type: 'gauge',
        values: [
          { value: 1024, labels: { connection: 'a' } },
          { value: 2048, labels: { connection: 'b' } },
        ],
      },
      {
        name: 'betterdb_polls_total',
        help: 'polls',
        type: 'counter',
        values: [{ value: 7, labels: { connection: 'a' } }],
      },
    ]);
    const meter = new FakeMeter();
    const service = await initWithMeter(prom, meter);

    const points = await meter.collect();

    expect(points).toEqual([
      {
        instrument: 'betterdb_memory_used_bytes',
        value: 1024,
        attributes: { connection: 'a' },
      },
      {
        instrument: 'betterdb_memory_used_bytes',
        value: 2048,
        attributes: { connection: 'b' },
      },
      { instrument: 'betterdb_polls_total', value: 7, attributes: { connection: 'a' } },
    ]);
    await service.onModuleDestroy();
  });

  it('skips histograms and summaries rather than observing them', async () => {
    const prom = makePrometheus([
      {
        name: 'betterdb_memory_used_bytes',
        help: 'mem',
        type: 'gauge',
        values: [{ value: 5, labels: {} }],
      },
      {
        name: 'betterdb_poll_duration',
        help: 'dur',
        type: 'histogram',
        values: [{ value: 3, labels: { le: '0.5' } }],
      },
    ]);
    const meter = new FakeMeter();
    const service = await initWithMeter(prom, meter);

    const points = await meter.collect();

    expect(points.map((point) => point.instrument)).toEqual(['betterdb_memory_used_bytes']);
    await service.onModuleDestroy();
  });

  it('mirrors metric families first registered after startup', async () => {
    const prom = makePrometheus([
      {
        name: 'betterdb_memory_used_bytes',
        help: 'mem',
        type: 'gauge',
        values: [{ value: 1, labels: {} }],
      },
    ]);
    const meter = new FakeMeter();
    const service = await initWithMeter(prom, meter);

    // A family that did not exist at init — e.g. collectDefaultMetrics, which
    // registers in PrometheusService.onModuleInit, after this service planned.
    prom.collectMetricsAsJson.mockResolvedValue([
      {
        name: 'betterdb_memory_used_bytes',
        help: 'mem',
        type: 'gauge',
        values: [{ value: 1, labels: {} }],
      },
      {
        name: 'betterdb_process_cpu_seconds_total',
        help: 'cpu',
        type: 'counter',
        values: [{ value: 42, labels: {} }],
      },
    ]);

    const firstCycle = await meter.collect();
    expect(firstCycle.map((point) => point.instrument)).toEqual(['betterdb_memory_used_bytes']);
    expect(meter.observedCount).toBe(2);

    const secondCycle = await meter.collect();

    expect(secondCycle).toContainEqual({
      instrument: 'betterdb_process_cpu_seconds_total',
      value: 42,
      attributes: {},
    });
    await service.onModuleDestroy();
  });

  it('attaches a derived UCUM unit only to instruments whose name implies one', async () => {
    const prom = makePrometheus([
      {
        name: 'betterdb_memory_used_bytes',
        help: 'mem',
        type: 'gauge',
        values: [{ value: 1, labels: {} }],
      },
      {
        name: 'betterdb_polls_total',
        help: 'polls',
        type: 'counter',
        values: [{ value: 1, labels: {} }],
      },
    ]);
    const meter = new FakeMeter();
    const service = await initWithMeter(prom, meter);

    expect(meter.options.get('betterdb_memory_used_bytes')).toEqual({
      description: 'mem',
      unit: 'By',
    });
    // No derivable unit → the key is omitted entirely, not set to ''.
    expect(meter.options.get('betterdb_polls_total')).toEqual({ description: 'polls' });
    await service.onModuleDestroy();
  });

  it('warns and stays inert when the registry exposes nothing mirrorable', async () => {
    const prom = makePrometheus([]);
    const meter = new FakeMeter();
    const service = await initWithMeter(prom, meter);

    expect(meter.callback).toBeUndefined();
    await service.onModuleDestroy();
  });
});
