import type { Attributes } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { MetricData, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';

const OVERFLOW_ATTRIBUTE = 'otel.metric.overflow';

const MIN_INTERVALS_KEPT = 2;

export function seriesBoundMs(stalenessMs: number, exportIntervalMs: number): number {
  return Math.max(stalenessMs, exportIntervalMs * MIN_INTERVALS_KEPT);
}

function seriesKey(name: string, attributes: Attributes): string {
  const entries = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([name, entries]);
}

export class SeriesLastSeen {
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly boundMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  observe(name: string, attributes: Attributes): void {
    this.lastSeen.set(seriesKey(name, attributes), this.now());
  }

  isFresh(name: string, attributes: Attributes): boolean {
    if (attributes[OVERFLOW_ATTRIBUTE] === true) {
      return true;
    }
    const seen = this.lastSeen.get(seriesKey(name, attributes));
    return seen !== undefined && this.now() - seen <= this.boundMs;
  }

  prune(): void {
    const now = this.now();
    for (const [key, seen] of this.lastSeen) {
      if (now - seen > this.boundMs) {
        this.lastSeen.delete(key);
      }
    }
  }
}

export function dropExpiredSeries(
  resourceMetrics: ResourceMetrics,
  lastSeen: SeriesLastSeen,
): ResourceMetrics {
  const scopeMetrics = resourceMetrics.scopeMetrics
    .map((scope) => ({
      scope: scope.scope,
      metrics: scope.metrics
        .map((metric) => {
          const dataPoints = (metric.dataPoints as MetricData['dataPoints'][number][]).filter(
            (point) => lastSeen.isFresh(metric.descriptor.name, point.attributes),
          );
          return { ...metric, dataPoints } as MetricData;
        })
        .filter((metric) => metric.dataPoints.length > 0),
    }))
    .filter((scope) => scope.metrics.length > 0);
  return { resource: resourceMetrics.resource, scopeMetrics };
}

export class SeriesExpiringExporter implements PushMetricExporter {
  readonly selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  readonly selectAggregation?: PushMetricExporter['selectAggregation'];

  constructor(
    private readonly inner: PushMetricExporter,
    private readonly lastSeen: SeriesLastSeen,
  ) {
    this.selectAggregationTemporality = inner.selectAggregationTemporality?.bind(inner);
    this.selectAggregation = inner.selectAggregation?.bind(inner);
  }

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    const fresh = dropExpiredSeries(metrics, this.lastSeen);
    this.lastSeen.prune();
    if (fresh.scopeMetrics.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    this.inner.export(fresh, resultCallback);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
