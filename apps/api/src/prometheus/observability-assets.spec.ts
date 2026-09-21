import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { PrometheusService } from './prometheus.service';
import type { ConnectionRegistry } from '../connections/connection-registry.service';
import type { ConfigService } from '@nestjs/config';
import type { StoragePort } from '../common/interfaces/storage-port.interface';

export const REPO_ROOT = path.resolve(__dirname, '../../../..');
export const COLLECTOR_DIR = path.join(REPO_ROOT, 'deploy/observability/collector');
export const DASHBOARD_DIR = path.join(REPO_ROOT, 'deploy/observability/dashboards');

export function registeredMetricNames(): Set<string> {
  const connections = {
    getConfig: jest.fn().mockReturnValue({ host: '10.0.0.1', port: 6379 }),
    get: jest.fn(),
    list: jest.fn().mockReturnValue([]),
  } as unknown as ConnectionRegistry;
  const config = {
    get: jest.fn((_key: string, fallback?: unknown) => fallback),
  } as unknown as ConfigService;
  const service = new PrometheusService(
    {} as StoragePort,
    connections,
    config,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return new Set(
    service['registry'].getMetricsAsArray().map((metric: { name: string }) => metric.name),
  );
}

export function metricNamesIn(expr: string): string[] {
  return [...expr.matchAll(/betterdb_[a-z0-9_]+/g)].map((match) => match[0]);
}

interface CollectorConfig {
  receivers: Record<string, unknown>;
  processors: Record<string, unknown>;
  exporters: Record<string, unknown>;
  service: {
    pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }>;
  };
}

function loadCollector(file: string): CollectorConfig {
  return parseYaml(readFileSync(path.join(COLLECTOR_DIR, file), 'utf8')) as CollectorConfig;
}

describe('OTel Collector configs', () => {
  const files = ['otel-collector.yaml', 'otel-collector.fanout.yaml'];

  it.each(files)('%s accepts OTLP over grpc and http', (file) => {
    const config = loadCollector(file);
    const protocols = (config.receivers.otlp as { protocols: Record<string, { endpoint: string }> })
      .protocols;

    expect(protocols.grpc.endpoint).toBe('0.0.0.0:4317');
    expect(protocols.http.endpoint).toBe('0.0.0.0:4318');
  });

  it.each(files)('%s wires every pipeline component it declares', (file) => {
    const config = loadCollector(file);
    const pipeline = config.service.pipelines.metrics;

    for (const name of pipeline.receivers) {
      expect(Object.keys(config.receivers)).toContain(name);
    }
    for (const name of pipeline.processors) {
      expect(Object.keys(config.processors)).toContain(name);
    }
    for (const name of pipeline.exporters) {
      expect(Object.keys(config.exporters)).toContain(name);
    }
  });

  it.each(files)('%s uses every component it defines', (file) => {
    const config = loadCollector(file);
    const pipeline = config.service.pipelines.metrics;
    const used = new Set([...pipeline.receivers, ...pipeline.processors, ...pipeline.exporters]);

    for (const name of [
      ...Object.keys(config.receivers),
      ...Object.keys(config.processors),
      ...Object.keys(config.exporters),
    ]) {
      expect(used.has(name)).toBe(true);
    }
  });

  it('fans out to a second backend only in the fanout config', () => {
    expect(loadCollector('otel-collector.yaml').service.pipelines.metrics.exporters).toEqual([
      'prometheus',
      'debug',
    ]);
    expect(loadCollector('otel-collector.fanout.yaml').service.pipelines.metrics.exporters).toEqual(
      ['prometheus', 'otlphttp/secondary', 'debug'],
    );
  });
});

it('registers the metric families the dashboards are built on', () => {
  const names = registeredMetricNames();

  expect(names.has('betterdb_memory_used_bytes')).toBe(true);
  expect(names.has('betterdb_slowlog_pattern_count')).toBe(true);
  expect(names.has('betterdb_cluster_slot_keys')).toBe(true);
  expect(names.has('betterdb_anomaly_events_current')).toBe(true);
});

it('extracts metric names from a PromQL expression', () => {
  expect(
    metricNamesIn('rate(betterdb_keyspace_hits_total{connection=~"$connection"}[5m])'),
  ).toEqual(['betterdb_keyspace_hits_total']);
});
