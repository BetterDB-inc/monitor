import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { OtelMetricsExporterService } from '../otel-metrics-exporter.service';
import type { PrometheusService } from '../../prometheus/prometheus.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';

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

function makeRegistry(): ConnectionRegistry {
  return { list: jest.fn().mockReturnValue([]) } as unknown as ConnectionRegistry;
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
  readonly kinds = new Map<string, 'gauge' | 'counter' | 'updown'>();
  private observed: object[] = [];
  private readonly names = new Map<object, string>();

  createObservableGauge(name: string, options?: { description?: string; unit?: string }): object {
    this.options.set(name, options ?? {});
    this.kinds.set(name, 'gauge');
    return this.track(name);
  }

  createObservableCounter(name: string, options?: { description?: string; unit?: string }): object {
    this.options.set(name, options ?? {});
    this.kinds.set(name, 'counter');
    return this.track(name);
  }

  createObservableUpDownCounter(
    name: string,
    options?: { description?: string; unit?: string },
  ): object {
    this.options.set(name, options ?? {});
    this.kinds.set(name, 'updown');
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
  env: Record<string, unknown> = {},
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
      ...env,
    }),
    prom,
    makeRegistry(),
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
      makeRegistry(),
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
      makeRegistry(),
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
      makeRegistry(),
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

  describe('export mode', () => {
    const CONN = '10.0.0.1:6379';
    const snapshot = [
      {
        name: 'betterdb_memory_used_bytes',
        help: 'mem',
        type: 'gauge',
        values: [{ value: 1000, labels: { connection: CONN } }],
      },
      {
        name: 'betterdb_connected_clients',
        help: 'clients',
        type: 'gauge',
        values: [{ value: 5, labels: { connection: CONN } }],
      },
      {
        name: 'betterdb_db_keys',
        help: 'keys',
        type: 'gauge',
        values: [{ value: 3, labels: { connection: CONN, db: 'bogus' } }],
      },
    ];

    it('observes semconv instruments in semconv mode', async () => {
      const meter = new FakeMeter();
      await initWithMeter(makePrometheus(snapshot), meter, {
        OTEL_METRICS_EXPORT_MODE: 'semconv',
      });

      expect(meter.kinds.get('valkey.memory.used')).toBe('gauge');
      expect(meter.kinds.get('valkey.clients.connected')).toBe('updown');
      expect(meter.options.get('valkey.memory.used')).toEqual({ description: 'mem', unit: 'By' });
      expect(await meter.collect()).toEqual([
        { instrument: 'valkey.memory.used', value: 1000, attributes: { connection: CONN } },
        { instrument: 'valkey.clients.connected', value: 5, attributes: { connection: CONN } },
      ]);
    });

    it('accepts the mode case-insensitively with surrounding spaces', async () => {
      const meter = new FakeMeter();
      await initWithMeter(makePrometheus(snapshot), meter, {
        OTEL_METRICS_EXPORT_MODE: ' SemConv ',
      });

      expect(meter.kinds.has('valkey.memory.used')).toBe(true);
    });

    it('logs a skipped point once per family', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const meter = new FakeMeter();
      await initWithMeter(makePrometheus(snapshot), meter, {
        OTEL_METRICS_EXPORT_MODE: 'semconv',
      });

      await meter.collect();
      await meter.collect();

      expect(
        debug.mock.calls.filter(([message]) => String(message).includes('betterdb_db_keys')),
      ).toHaveLength(1);
    });

    it('warns and mirrors on an unknown mode', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const meter = new FakeMeter();
      await initWithMeter(makePrometheus(snapshot), meter, { OTEL_METRICS_EXPORT_MODE: 'otel' });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('OTEL_METRICS_EXPORT_MODE'));
      expect(meter.kinds.get('betterdb_memory_used_bytes')).toBe('gauge');
      expect(meter.kinds.has('valkey.memory.used')).toBe(false);
    });

    it('warns without mentioning the mirror when semconv finds nothing to export', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const meter = new FakeMeter();
      const service = await initWithMeter(makePrometheus([]), meter, {
        OTEL_METRICS_EXPORT_MODE: 'semconv',
      });

      expect(warn).toHaveBeenCalledWith(
        'OTel metrics export found no exportable metrics; nothing will be exported',
      );
      expect(meter.callback).toBeUndefined();
      await service.onModuleDestroy();
    });

    it('mirrors when the mode is empty', async () => {
      const meter = new FakeMeter();
      await initWithMeter(makePrometheus(snapshot), meter, { OTEL_METRICS_EXPORT_MODE: '' });

      expect(meter.kinds.has('betterdb_memory_used_bytes')).toBe(true);
    });
  });
});
