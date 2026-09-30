import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BatchObservableCallback,
  Meter,
  ObservableGauge,
  ObservableCounter,
  ObservableUpDownCounter,
} from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { PrometheusService } from '../prometheus/prometheus.service';
import { planInstruments, collectDataPoints, type PromMetricJson } from './prom-otel-bridge';
import {
  planSemconvInstruments,
  collectSemconvPoints,
  type SemconvCollection,
  type SemconvInstrumentSpec,
} from './semconv-map';
import { NodeSplittingExporter, buildNodeResolver } from './node-splitting-exporter';

type MirrorInstrument = ObservableGauge | ObservableCounter | ObservableUpDownCounter;

type ExportMode = 'mirror' | 'semconv';

interface ExportStrategy {
  meterName: string;
  plan(snapshot: PromMetricJson[]): SemconvInstrumentSpec[];
  collect(metric: PromMetricJson): SemconvCollection;
}

const MIRROR_STRATEGY: ExportStrategy = {
  meterName: 'betterdb-prometheus-mirror',
  plan: (snapshot) => planInstruments(snapshot),
  collect: (metric) => ({
    points: collectDataPoints(metric).map((point) => ({ instrument: metric.name, ...point })),
    skipped: 0,
  }),
};

const SEMCONV_STRATEGY: ExportStrategy = {
  meterName: 'betterdb-semconv',
  plan: planSemconvInstruments,
  collect: collectSemconvPoints,
};

function parseExportMode(raw: unknown): ExportMode | null {
  const value = raw === undefined || raw === null ? '' : String(raw).trim().toLowerCase();
  if (value === '' || value === 'mirror') {
    return 'mirror';
  }
  return value === 'semconv' ? 'semconv' : null;
}

/**
 * Mirrors the existing prom-client registry to an OTLP metrics endpoint on an
 * interval. Reads the same registry the /metrics scrape uses, so no metric
 * emission site changes. Each prom-client metric name becomes one instrument;
 * dynamic label sets ride along as OTel attributes observed each collection.
 * Families registered after startup (e.g. collectDefaultMetrics, which runs in
 * PrometheusService.onModuleInit) are picked up during collection and observed
 * from the next cycle onward, so mirroring does not depend on module init order.
 * No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set and OTEL_TELEMETRY_ENABLED.
 */
@Injectable()
export class OtelMetricsExporterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OtelMetricsExporterService.name);
  private provider?: MeterProvider;
  private readonly instruments = new Map<string, MirrorInstrument>();
  private observedInstruments: MirrorInstrument[] = [];
  private observeCallback?: BatchObservableCallback;
  private strategy: ExportStrategy = MIRROR_STRATEGY;
  private readonly skipLogged = new Set<string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly prometheusService: PrometheusService,
    private readonly connectionRegistry: ConnectionRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = String(this.configService.get('OTEL_TELEMETRY_ENABLED', 'true')) !== 'false';
    const endpoint = this.configService.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
    if (!enabled || !endpoint) {
      this.logger.log('OTel metrics mirror disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)');
      return;
    }

    const mode = this.resolveExportMode();
    this.strategy = mode === 'semconv' ? SEMCONV_STRATEGY : MIRROR_STRATEGY;
    const intervalMs = this.configService.get<number>('OTEL_METRICS_EXPORT_INTERVAL_MS', 15000);
    const otlpExporter = new OTLPMetricExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/metrics`,
    });
    const exporter: PushMetricExporter =
      mode === 'semconv'
        ? new NodeSplittingExporter(otlpExporter, () =>
            buildNodeResolver(this.connectionRegistry.list()),
          )
        : otlpExporter;
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: intervalMs,
    });
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'betterdb-monitor' }),
      readers: [reader],
    });

    await this.registerMirror(this.provider.getMeter(this.strategy.meterName));
    const label = mode === 'semconv' ? 'semconv export' : 'mirror';
    this.logger.log(`OTel metrics ${label} active → ${endpoint} (every ${intervalMs}ms)`);
  }

  private resolveExportMode(): ExportMode {
    const raw = this.configService.get<string>('OTEL_METRICS_EXPORT_MODE');
    const mode = parseExportMode(raw);
    if (mode) {
      return mode;
    }
    this.logger.warn(`Unknown OTEL_METRICS_EXPORT_MODE "${raw}"; using mirror`);
    return 'mirror';
  }

  private async collectSnapshot(): Promise<PromMetricJson[]> {
    // prom-client types `type` as a numeric enum, but getMetricsAsJSON returns
    // it as a string ('gauge' / 'counter' / ...) at runtime — cast to the shape
    // the bridge actually consumes.
    return (await this.prometheusService.collectMetricsAsJson()) as unknown as PromMetricJson[];
  }

  private async registerMirror(meter: Meter): Promise<void> {
    this.syncInstruments(meter, await this.collectSnapshot());
    if (this.instruments.size === 0) {
      // The SDK rejects a batch callback with no instruments, so there would be
      // nothing to re-sync from later and the mirror would stay inert.
      this.logger.warn(
        'OTel metrics export found no exportable metrics; nothing will be exported',
      );
      return;
    }

    this.observeCallback = async (result) => {
      const current = await this.collectSnapshot();
      // Re-observing the callback is what picks up families registered after
      // startup. The SDK snapshots its callback list before awaiting any of
      // them, so a re-registration here takes effect from the next cycle.
      const added = this.syncInstruments(meter, current);
      if (added) {
        this.reobserve(meter);
      }
      for (const metric of current) {
        const { points, skipped } = this.strategy.collect(metric);
        if (skipped > 0) {
          this.logSkipped(metric.name, skipped);
        }
        for (const point of points) {
          const instrument = this.instruments.get(point.instrument);
          if (!instrument) {
            continue;
          }
          result.observe(instrument, point.value, point.attributes);
        }
      }
    };
    this.reobserve(meter);
  }

  private logSkipped(family: string, count: number): void {
    if (this.skipLogged.has(family)) {
      return;
    }
    this.skipLogged.add(family);
    this.logger.debug(`Skipped ${count} unconvertible ${family} point(s) in the semconv export`);
  }

  /**
   * Creates instruments for metric families not seen before. Returns whether
   * any were added, i.e. whether the observed-instrument set is now stale.
   */
  private syncInstruments(meter: Meter, snapshot: PromMetricJson[]): boolean {
    let added = false;
    for (const spec of this.strategy.plan(snapshot)) {
      if (this.instruments.has(spec.name)) {
        continue;
      }
      this.instruments.set(spec.name, this.createInstrument(meter, spec));
      added = true;
    }
    return added;
  }

  private reobserve(meter: Meter): void {
    if (!this.observeCallback) {
      return;
    }
    if (this.observedInstruments.length > 0) {
      meter.removeBatchObservableCallback(this.observeCallback, this.observedInstruments);
    }
    this.observedInstruments = [...this.instruments.values()];
    if (this.observedInstruments.length === 0) {
      return;
    }
    meter.addBatchObservableCallback(this.observeCallback, this.observedInstruments);
  }

  private createInstrument(meter: Meter, spec: SemconvInstrumentSpec): MirrorInstrument {
    // Only pass unit when we could derive one; an empty unit is meaningful noise
    // in OTLP metadata, so omit the key entirely in that case.
    const options = spec.unit
      ? { description: spec.description, unit: spec.unit }
      : { description: spec.description };
    if (spec.kind === 'counter') {
      return meter.createObservableCounter(spec.name, options);
    }
    if (spec.kind === 'updown') {
      return meter.createObservableUpDownCounter(spec.name, options);
    }
    return meter.createObservableGauge(spec.name, options);
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.provider) {
      return;
    }
    await this.provider.shutdown().catch(() => {});
  }
}
