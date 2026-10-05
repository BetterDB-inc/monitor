import { ConfigService } from '@nestjs/config';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import type { MeterProvider, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { OtelMetricsExporterService } from '../otel-metrics-exporter.service';
import type { PromMetricJson } from '../prom-otel-bridge';
import type { PrometheusService } from '../../prometheus/prometheus.service';
import type { ConnectionRegistry } from '../../connections/connection-registry.service';

const NODE = '10.0.0.1:6379';
const STALENESS_MS = 15_000;
const INTERVAL_MS = 5_000;

function config(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string, def?: T): T | undefined => (key in values ? (values[key] as T) : def),
  } as unknown as ConfigService;
}

function instanceInfo(role: string): PromMetricJson {
  return {
    name: 'betterdb_instance_info',
    help: 'Instance info',
    type: 'gauge',
    values: [{ value: 1, labels: { connection: NODE, role, version: '8.1.0', os: 'linux' } }],
  };
}

function memoryUsed(...connections: string[]): PromMetricJson {
  return {
    name: 'betterdb_memory_used_bytes',
    help: 'Used memory',
    type: 'gauge',
    values: connections.map((connection) => ({ value: 100, labels: { connection } })),
  };
}

interface Harness {
  setSnapshot: (snapshot: PromMetricJson[]) => void;
  advance: (ms: number) => void;
  cycle: () => Promise<ResourceMetrics[]>;
  stop: () => Promise<void>;
}

async function start(mode: 'mirror' | 'semconv', initial: PromMetricJson[]): Promise<Harness> {
  let snapshot = initial;
  let now = 1_000_000;
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  let exported: ResourceMetrics[] = [];
  jest
    .spyOn(OTLPMetricExporter.prototype, 'export')
    .mockImplementation((metrics: ResourceMetrics, callback: (result: ExportResult) => void) => {
      exported.push(metrics);
      callback({ code: ExportResultCode.SUCCESS });
    });
  jest.spyOn(OTLPMetricExporter.prototype, 'forceFlush').mockResolvedValue(undefined);
  jest.spyOn(OTLPMetricExporter.prototype, 'shutdown').mockResolvedValue(undefined);

  const prometheus = {
    collectMetricsAsJson: jest.fn(async () => snapshot),
    getStalenessMs: () => STALENESS_MS,
  } as unknown as PrometheusService;
  const registry = {
    list: () => [
      { id: 'a', name: 'a', host: '10.0.0.1', port: 6379, isConnected: true },
      { id: 'b', name: 'b', host: '10.0.0.2', port: 6380, isConnected: true },
    ],
  } as unknown as ConnectionRegistry;
  const service = new OtelMetricsExporterService(
    config({
      OTEL_TELEMETRY_ENABLED: true,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_METRICS_EXPORT_INTERVAL_MS: INTERVAL_MS,
      OTEL_METRICS_EXPORT_MODE: mode,
    }),
    prometheus,
    registry,
  );
  await service.onModuleInit();
  const provider = (service as unknown as { provider: MeterProvider }).provider;

  return {
    setSnapshot: (next) => {
      snapshot = next;
    },
    advance: (ms) => {
      now += ms;
    },
    cycle: async () => {
      exported = [];
      await provider.forceFlush();
      return exported;
    },
    stop: () => service.onModuleDestroy(),
  };
}

function points(exported: ResourceMetrics[], name: string): Record<string, unknown>[] {
  return exported.flatMap((rm) =>
    rm.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .filter((metric) => metric.descriptor.name === name)
      .flatMap((metric) =>
        (metric.dataPoints as { attributes: Record<string, unknown> }[]).map((point) => ({
          ...point.attributes,
          instance: rm.resource.attributes['service.instance.id'],
        })),
      ),
  );
}

describe('series expiry through the real SDK pipeline', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
    jest.restoreAllMocks();
  });

  it('reports only the current role after a failover once the old role expires (semconv)', async () => {
    harness = await start('semconv', [instanceInfo('master')]);
    await harness.cycle();

    harness.setSnapshot([instanceInfo('slave')]);
    harness.advance(INTERVAL_MS);
    expect(points(await harness.cycle(), 'valkey.role').map((p) => p.role)).toEqual([
      'primary',
      'replica',
    ]);

    harness.advance(STALENESS_MS);
    expect(points(await harness.cycle(), 'valkey.role')).toEqual([
      { role: 'replica', instance: NODE },
    ]);
  });

  it('stops exporting a series once it has not been observed for the bound (mirror)', async () => {
    harness = await start('mirror', [memoryUsed(NODE, '10.0.0.2:6380')]);
    await harness.cycle();

    harness.setSnapshot([memoryUsed(NODE)]);
    harness.advance(STALENESS_MS);
    expect(points(await harness.cycle(), 'betterdb_memory_used_bytes')).toHaveLength(2);

    harness.advance(1);
    expect(
      points(await harness.cycle(), 'betterdb_memory_used_bytes').map((p) => p.connection),
    ).toEqual([NODE]);
  });

  it('exports an expired series again once it is observed again (mirror)', async () => {
    harness = await start('mirror', [memoryUsed(NODE, '10.0.0.2:6380')]);
    await harness.cycle();

    harness.setSnapshot([memoryUsed(NODE)]);
    harness.advance(STALENESS_MS + 1);
    expect(points(await harness.cycle(), 'betterdb_memory_used_bytes')).toHaveLength(1);

    harness.setSnapshot([memoryUsed(NODE, '10.0.0.2:6380')]);
    harness.advance(INTERVAL_MS);
    expect(
      points(await harness.cycle(), 'betterdb_memory_used_bytes')
        .map((p) => p.connection)
        .sort(),
    ).toEqual([NODE, '10.0.0.2:6380']);
  });

  it('drops a node resource whose series all expired (semconv)', async () => {
    harness = await start('semconv', [memoryUsed(NODE, '10.0.0.2:6380')]);
    await harness.cycle();

    harness.setSnapshot([memoryUsed(NODE)]);
    harness.advance(STALENESS_MS + 1);
    const exported = await harness.cycle();

    expect(exported.map((rm) => rm.resource.attributes['service.instance.id'])).toEqual([NODE]);
  });
});
