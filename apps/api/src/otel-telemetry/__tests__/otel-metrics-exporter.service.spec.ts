import { ConfigService } from '@nestjs/config';
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

describe('OtelMetricsExporterService', () => {
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
        OTEL_TELEMETRY_ENABLED: false,
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
});
