import { readdirSync, readFileSync } from 'node:fs';
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

interface DashboardTarget {
  refId: string;
  expr: string;
  format?: string;
  datasource?: { type: string; uid: string };
}

interface DashboardPanel {
  id: number;
  type: string;
  title: string;
  targets?: DashboardTarget[];
  panels?: DashboardPanel[];
}

interface DashboardVariable {
  name: string;
  type: string;
  label?: string;
  query?: string | { query: string };
}

interface Dashboard {
  uid: string;
  title: string;
  schemaVersion: number;
  templating: { list: DashboardVariable[] };
  panels: DashboardPanel[];
}

function loadDashboard(file: string): Dashboard {
  return JSON.parse(readFileSync(path.join(DASHBOARD_DIR, file), 'utf8')) as Dashboard;
}

function allPanels(dashboard: Dashboard): DashboardPanel[] {
  return dashboard.panels.flatMap((panel) => [panel, ...(panel.panels ?? [])]);
}

describe('Grafana dashboard pack', () => {
  const files = [
    'betterdb-instance-vitals.json',
    'betterdb-query-patterns.json',
    'betterdb-cluster-slots.json',
    'betterdb-anomalies.json',
  ];

  it.each(files)('%s declares the shared contract', (file) => {
    const dashboard = loadDashboard(file);

    expect(dashboard.uid).toBe(file.replace('.json', ''));
    expect(dashboard.title.startsWith('BetterDB · ')).toBe(true);
    expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(39);
  });

  it.each(files)('%s exposes a datasource variable first', (file) => {
    const [variable] = loadDashboard(file).templating.list;

    expect(variable.name).toBe('ds');
    expect(variable.type).toBe('datasource');
    expect(variable.query).toBe('prometheus');
  });

  it.each(files)('%s exposes a scrape job variable', (file) => {
    const variable = loadDashboard(file).templating.list.find((item) => item.name === 'job');

    expect(variable?.type).toBe('query');
    expect(variable?.query).toEqual({
      query: 'label_values(betterdb_memory_used_bytes, job)',
      refId: 'StandardVariableQuery',
    });
  });

  it.each(files)('%s exposes a connection variable', (file) => {
    const variable = loadDashboard(file).templating.list.find((item) => item.name === 'connection');

    expect(variable?.type).toBe('query');
    expect(variable?.query).toEqual({
      query: 'label_values(betterdb_memory_used_bytes{job=~"$job"}, connection)',
      refId: 'connection',
    });
  });

  it.each(files)('%s points every target at the datasource variable', (file) => {
    const targets = allPanels(loadDashboard(file)).flatMap((panel) => panel.targets ?? []);

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.datasource).toEqual({ type: 'prometheus', uid: '${ds}' });
    }
  });

  it.each(files)('%s leaves no literal datasource uid behind', (file) => {
    expect(readFileSync(path.join(DASHBOARD_DIR, file), 'utf8')).not.toContain(
      'betterdb-prometheus',
    );
  });

  it.each(files)('%s only queries metrics the service registers', (file) => {
    const registered = registeredMetricNames();
    const used = allPanels(loadDashboard(file))
      .flatMap((panel) => panel.targets ?? [])
      .flatMap((target) => metricNamesIn(target.expr));

    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      const base = name.replace(/_(bucket|sum)$/, '');
      expect(registered.has(name) || registered.has(base)).toBe(true);
    }
  });

  it.each(files)('%s filters every query by the connection variable', (file) => {
    const targets = allPanels(loadDashboard(file)).flatMap((panel) => panel.targets ?? []);

    for (const target of targets) {
      expect(target.expr).toContain('connection=~"$connection"');
    }
  });

  it.each(files)('%s filters every query by the scrape job variable', (file) => {
    const targets = allPanels(loadDashboard(file)).flatMap((panel) => panel.targets ?? []);

    for (const target of targets) {
      expect(target.expr).toContain('job=~"$job"');
    }
  });

  it.each(files)('%s pins every selector to both variables', (file) => {
    const targets = allPanels(loadDashboard(file)).flatMap((panel) => panel.targets ?? []);

    for (const target of targets) {
      const selectors = [...target.expr.matchAll(/betterdb_[a-z0-9_]+\{([^}]*)\}/g)];

      expect(selectors.length).toBeGreaterThan(0);
      for (const [, selector] of selectors) {
        expect(selector).toBe('job=~"$job",connection=~"$connection"');
      }
    }
  });

  it.each(files)('%s asks for table frames on every table panel', (file) => {
    const tables = allPanels(loadDashboard(file)).filter((panel) => panel.type === 'table');

    expect(tables.length).toBeGreaterThan(0);
    for (const panel of tables) {
      expect(panel.targets?.length).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) {
        expect(target.format).toBe('table');
      }
    }
  });

  it('provisions every dashboard file in the directory', () => {
    const onDisk = readdirSync(DASHBOARD_DIR).filter((file) => file.endsWith('.json'));

    expect(onDisk.sort()).toEqual([...files].sort());
  });
});

describe('demo stack', () => {
  const DEMO_DIR = path.join(REPO_ROOT, 'deploy/observability/demo');

  interface ComposeFile {
    services: Record<
      string,
      { image: string; volumes?: string[]; ports?: string[]; environment?: string[] }
    >;
  }

  function loadCompose(): ComposeFile {
    return parseYaml(
      readFileSync(path.join(DEMO_DIR, 'docker-compose.yml'), 'utf8'),
    ) as ComposeFile;
  }

  it('runs the five services the demo needs', () => {
    expect(Object.keys(loadCompose().services).sort()).toEqual([
      'betterdb',
      'grafana',
      'otel-collector',
      'prometheus',
      'valkey',
    ]);
  });

  it('mounts the shipped collector config and dashboard pack', () => {
    const services = loadCompose().services;

    expect(services['otel-collector'].volumes).toContain(
      '../collector/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro',
    );
    expect(services.grafana.volumes).toContain('../dashboards:/var/lib/grafana/dashboards:ro');
  });

  it('points the monitor at the collector', () => {
    expect(loadCompose().services.betterdb.environment).toContain(
      'OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318',
    );
  });

  it('provisions a default Prometheus datasource for the dashboards', () => {
    const datasource = parseYaml(
      readFileSync(path.join(DEMO_DIR, 'grafana/provisioning/datasources/prometheus.yaml'), 'utf8'),
    ) as { datasources: Array<{ uid: string; url: string; isDefault: boolean }> };

    expect(datasource.datasources[0].uid).toBe('betterdb-prometheus');
    expect(datasource.datasources[0].url).toBe('http://prometheus:9090');
    expect(datasource.datasources[0].isDefault).toBe(true);
  });

  it('scrapes both the monitor and the collector', () => {
    const prometheus = parseYaml(readFileSync(path.join(DEMO_DIR, 'prometheus.yml'), 'utf8')) as {
      scrape_configs: Array<{
        job_name: string;
        metrics_path?: string;
        static_configs: Array<{ targets: string[] }>;
      }>;
    };
    const jobs = Object.fromEntries(prometheus.scrape_configs.map((job) => [job.job_name, job]));

    expect(jobs.betterdb.metrics_path).toBe('/api/prometheus/metrics');
    expect(jobs.betterdb.static_configs[0].targets).toEqual(['betterdb:3001']);
    expect(jobs['otel-collector'].static_configs[0].targets).toEqual(['otel-collector:8889']);
  });
});
