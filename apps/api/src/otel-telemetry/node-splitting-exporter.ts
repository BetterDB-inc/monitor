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

export const MAX_CONCURRENT_EXPORTS = 8;

const AGENT_HOST = 'agent';

const SUPERSEDED = new Error('Export superseded by a newer collection before a slot was free');

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
    if (connection.host === AGENT_HOST) {
      continue;
    }
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
  isRetired: (label: string) => boolean = () => false,
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
        if (!node && typeof label === 'string' && isRetired(label)) {
          continue;
        }
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

function partKey(part: ResourceMetrics): string {
  return String(part.resource.attributes['service.instance.id'] ?? '');
}

export class NodeSplittingExporter implements PushMetricExporter {
  readonly selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  readonly selectAggregation?: PushMetricExporter['selectAggregation'];
  private readonly knownNodes = new Map<string, NodeIdentity>();
  private activeExports = 0;
  private readonly waitingForSlot = new Map<string, (granted: boolean) => void>();

  constructor(
    private readonly inner: PushMetricExporter,
    private readonly createResolver: () => NodeResolver,
  ) {
    this.selectAggregationTemporality = inner.selectAggregationTemporality?.bind(inner);
    this.selectAggregation = inner.selectAggregation?.bind(inner);
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    const current = this.createResolver();
    const parts = splitByConnection(
      metrics,
      (label) => this.remember(label, current(label)),
      (label) => this.knownNodes.has(label),
    );
    if (parts.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    void Promise.all(parts.map((part) => this.exportWithSlot(part))).then((results) => {
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

  private remember(label: string, node: NodeIdentity | null): NodeIdentity | null {
    if (!node) {
      return null;
    }
    const last = this.knownNodes.get(label);
    const identity: NodeIdentity = { host: node.host, port: node.port };
    const dbType = node.dbType ?? last?.dbType;
    const version = node.version ?? last?.version;
    if (dbType) {
      identity.dbType = dbType;
    }
    if (version) {
      identity.version = version;
    }
    this.knownNodes.set(label, identity);
    return identity;
  }

  private async exportWithSlot(part: ResourceMetrics): Promise<ExportResult> {
    if (!(await this.acquireSlot(partKey(part)))) {
      return { code: ExportResultCode.FAILED, error: SUPERSEDED };
    }
    try {
      return await this.exportPart(part);
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(key: string): Promise<boolean> {
    if (this.activeExports < MAX_CONCURRENT_EXPORTS) {
      this.activeExports += 1;
      return Promise.resolve(true);
    }
    this.waitingForSlot.get(key)?.(false);
    return new Promise((resolve) => this.waitingForSlot.set(key, resolve));
  }

  private releaseSlot(): void {
    const next = this.waitingForSlot.entries().next();
    if (!next.done) {
      const [key, grant] = next.value;
      this.waitingForSlot.delete(key);
      grant(true);
    } else {
      this.activeExports -= 1;
    }
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
