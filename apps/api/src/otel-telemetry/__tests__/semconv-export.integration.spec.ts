import { ConfigService } from '@nestjs/config';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import type { MetricData, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { OtelMetricsExporterService } from '../otel-metrics-exporter.service';
import { ORPHAN_ID, buildPrometheus, pollAll } from './prometheus-harness';

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, def?: T): T | undefined => (key in values ? (values[key] as T) : def),
  } as unknown as ConfigService;
}

async function exportOnce(env: Record<string, unknown> = {}): Promise<ResourceMetrics[]> {
  const exported: ResourceMetrics[] = [];
  jest
    .spyOn(OTLPMetricExporter.prototype, 'export')
    .mockImplementation((metrics: ResourceMetrics, callback: (result: ExportResult) => void) => {
      exported.push(metrics);
      callback({ code: ExportResultCode.SUCCESS });
    });
  jest.spyOn(OTLPMetricExporter.prototype, 'forceFlush').mockResolvedValue(undefined);
  jest.spyOn(OTLPMetricExporter.prototype, 'shutdown').mockResolvedValue(undefined);

  const { service: prometheus, registry } = buildPrometheus(env);
  await pollAll(prometheus);
  const exporter = new OtelMetricsExporterService(
    config({
      OTEL_TELEMETRY_ENABLED: true,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_METRICS_EXPORT_INTERVAL_MS: 600000,
      OTEL_METRICS_EXPORT_MODE: 'semconv',
      ...env,
    }),
    prometheus,
    registry,
  );
  await exporter.onModuleInit();
  await exporter.onModuleDestroy();
  return exported;
}

function byInstance(exported: ResourceMetrics[]): Map<string, ResourceMetrics> {
  return new Map(
    exported.map((rm) => [String(rm.resource.attributes['service.instance.id'] ?? 'monitor'), rm]),
  );
}

function metricNames(rm: ResourceMetrics): string[] {
  return rm.scopeMetrics.flatMap((scope) => scope.metrics.map((m) => m.descriptor.name));
}

function dataPointAttributes(metric: MetricData): Record<string, string | number>[] {
  return (metric.dataPoints as { attributes: Record<string, string | number> }[]).map(
    (point) => point.attributes,
  );
}

describe('semconv export through the real SDK pipeline', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exports one resource per node plus the monitor', async () => {
    const resources = byInstance(await exportOnce());

    expect([...resources.keys()].sort()).toEqual(['10.0.0.1:6379', '10.0.0.2:6380', 'monitor']);

    const node = resources.get('10.0.0.1:6379')!;
    expect(node.resource.attributes).toMatchObject({
      'service.name': 'valkey',
      'db.system.name': 'valkey',
      'server.address': '10.0.0.1',
      'server.port': 6379,
      'valkey.version': '8.1.0',
    });
    const metrics = node.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(metrics.find((m) => m.descriptor.name === 'valkey.memory.used')?.descriptor.unit).toBe(
      'By',
    );
    const cpu = metrics.find((m) => m.descriptor.name === 'valkey.cpu.time')!;
    expect(cpu.dataPoints.map((p) => p.attributes.state).sort()).toEqual(['sys', 'user']);
    expect(
      metrics.flatMap((m) => dataPointAttributes(m)).some((attrs) => 'connection' in attrs),
    ).toBe(false);

    const monitor = resources.get('monitor')!;
    expect(monitor.resource.attributes['service.name']).toBe('betterdb-monitor');
    expect(
      monitor.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .flatMap((m) => dataPointAttributes(m))
        .some((attrs) => attrs.connection === ORPHAN_ID),
    ).toBe(true);
  });

  it('still limits the export to the vitals profile', async () => {
    const node = byInstance(await exportOnce({ METRICS_EXPORT_PROFILE: 'vitals' })).get(
      '10.0.0.1:6379',
    )!;

    expect(metricNames(node)).toContain('valkey.memory.used');
    expect(metricNames(node)).not.toContain('valkey.db.keys');
  });
});
