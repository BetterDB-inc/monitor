import type { Attributes } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type {
  MetricData,
  PushMetricExporter,
  ResourceMetrics,
  ScopeMetrics,
} from '@opentelemetry/sdk-metrics';
import type { ConnectionStatus } from '@betterdb/shared';

export const CONNECTION_ATTRIBUTE = 'connection';

export interface NodeIdentity {
  host: string;
  port: number;
  dbType?: 'valkey' | 'redis';
  version?: string;
}

export type NodeResolver = (label: string) => NodeIdentity | null;

type AnyDataPoint = MetricData['dataPoints'][number];

interface Bucket {
  resource: Resource;
  scopes: Map<ScopeMetrics, Map<MetricData, AnyDataPoint[]>>;
}

export function buildNodeResolver(connections: ConnectionStatus[]): NodeResolver {
  const nodes = new Map<string, NodeIdentity>();
  for (const connection of connections) {
    const node: NodeIdentity = { host: connection.host, port: connection.port };
    if (connection.capabilities) {
      node.dbType = connection.capabilities.dbType;
      node.version = connection.capabilities.version;
    }
    nodes.set(`${connection.host}:${connection.port}`, node);
  }
  return (label) => nodes.get(label) ?? null;
}

export function nodeResourceAttributes(label: string, node: NodeIdentity): Attributes {
  return {
    'service.name': node.dbType ?? 'valkey',
    'service.instance.id': label,
    ...(node.dbType ? { 'db.system.name': node.dbType } : {}),
    'server.address': node.host,
    'server.port': node.port,
    ...(node.version ? { 'valkey.version': node.version } : {}),
  };
}

function withoutConnection(attributes: Attributes): Attributes {
  const rest: Attributes = { ...attributes };
  delete rest[CONNECTION_ATTRIBUTE];
  return rest;
}

export function splitByConnection(
  resourceMetrics: ResourceMetrics,
  resolve: NodeResolver,
): ResourceMetrics[] {
  const buckets = new Map<string, Bucket>();
  const monitorKey = '';

  const bucketFor = (key: string, resource: () => Resource): Bucket => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { resource: resource(), scopes: new Map() };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const point of metric.dataPoints as AnyDataPoint[]) {
        const label = point.attributes[CONNECTION_ATTRIBUTE];
        const node = typeof label === 'string' ? resolve(label) : null;
        const bucket =
          node && typeof label === 'string'
            ? bucketFor(label, () => resourceFromAttributes(nodeResourceAttributes(label, node)))
            : bucketFor(monitorKey, () => resourceMetrics.resource);
        const target = node ? { ...point, attributes: withoutConnection(point.attributes) } : point;
        let metrics = bucket.scopes.get(scope);
        if (!metrics) {
          metrics = new Map();
          bucket.scopes.set(scope, metrics);
        }
        const points = metrics.get(metric) ?? [];
        points.push(target);
        metrics.set(metric, points);
      }
    }
  }

  return [...buckets.values()].map((bucket) => ({
    resource: bucket.resource,
    scopeMetrics: [...bucket.scopes].map(([scope, metrics]) => ({
      scope: scope.scope,
      metrics: [...metrics].map(
        ([metric, dataPoints]) => ({ ...metric, dataPoints }) as MetricData,
      ),
    })),
  }));
}

export class NodeSplittingExporter implements PushMetricExporter {
  readonly selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  readonly selectAggregation?: PushMetricExporter['selectAggregation'];

  constructor(
    private readonly inner: PushMetricExporter,
    private readonly createResolver: () => NodeResolver,
  ) {
    this.selectAggregationTemporality = inner.selectAggregationTemporality?.bind(inner);
    this.selectAggregation = inner.selectAggregation?.bind(inner);
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    const parts = splitByConnection(metrics, this.createResolver());
    if (parts.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    void Promise.all(parts.map((part) => this.exportPart(part))).then((results) => {
      const failed = results.find((result) => result.code !== ExportResultCode.SUCCESS);
      resultCallback(failed ?? { code: ExportResultCode.SUCCESS });
    });
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  private exportPart(part: ResourceMetrics): Promise<ExportResult> {
    return new Promise((resolve) => {
      try {
        this.inner.export(part, resolve);
      } catch (error) {
        resolve({ code: ExportResultCode.FAILED, error: error as Error });
      }
    });
  }
}
