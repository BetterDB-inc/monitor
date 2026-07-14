import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Meter, ObservableGauge, ObservableCounter } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { PrometheusService } from '../prometheus/prometheus.service';
import {
  planInstruments,
  collectDataPoints,
  type InstrumentSpec,
  type PromMetricJson,
} from './prom-otel-bridge';

type MirrorInstrument = ObservableGauge | ObservableCounter;

/**
 * Mirrors the existing prom-client registry to an OTLP metrics endpoint on an
 * interval. Reads the same registry the /metrics scrape uses, so no metric
 * emission site changes. Every prom-client metric name is a static instrument;
 * dynamic label sets ride along as OTel attributes observed each collection.
 * No-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set and OTEL_TELEMETRY_ENABLED.
 */
@Injectable()
export class OtelMetricsExporterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OtelMetricsExporterService.name);
  private provider?: MeterProvider;

  constructor(
    private readonly configService: ConfigService,
    private readonly prometheusService: PrometheusService,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = this.configService.get<boolean>('OTEL_TELEMETRY_ENABLED', true);
    const endpoint = this.configService.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
    if (!enabled || !endpoint) {
      this.logger.log('OTel metrics mirror disabled (set OTEL_EXPORTER_OTLP_ENDPOINT to enable)');
      return;
    }

    const intervalMs = this.configService.get<number>('OTEL_METRICS_EXPORT_INTERVAL_MS', 15000);
    const exporter = new OTLPMetricExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/metrics`,
    });
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: intervalMs,
    });
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'betterdb-monitor' }),
      readers: [reader],
    });

    await this.registerMirror(this.provider.getMeter('betterdb-prometheus-mirror'));
    this.logger.log(`OTel metrics mirror active → ${endpoint} (every ${intervalMs}ms)`);
  }

  private async collectSnapshot(): Promise<PromMetricJson[]> {
    // prom-client types `type` as a numeric enum, but getMetricsAsJSON returns
    // it as a string ('gauge' / 'counter' / ...) at runtime — cast to the shape
    // the bridge actually consumes.
    return (await this.prometheusService.collectMetricsAsJson()) as unknown as PromMetricJson[];
  }

  private async registerMirror(meter: Meter): Promise<void> {
    const snapshot = await this.collectSnapshot();
    const instruments = new Map<string, MirrorInstrument>();
    for (const spec of planInstruments(snapshot)) {
      instruments.set(spec.name, this.createInstrument(meter, spec));
    }

    meter.addBatchObservableCallback(
      async (result) => {
        const current = await this.collectSnapshot();
        for (const metric of current) {
          const instrument = instruments.get(metric.name);
          if (!instrument) {
            continue;
          }
          for (const point of collectDataPoints(metric)) {
            result.observe(instrument, point.value, point.attributes);
          }
        }
      },
      [...instruments.values()],
    );
  }

  private createInstrument(meter: Meter, spec: InstrumentSpec): MirrorInstrument {
    if (spec.kind === 'counter') {
      return meter.createObservableCounter(spec.name, { description: spec.description });
    }
    return meter.createObservableGauge(spec.name, { description: spec.description });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.provider) {
      return;
    }
    await this.provider.shutdown().catch(() => {});
  }
}
