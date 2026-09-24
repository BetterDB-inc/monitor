import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { PrometheusService } from '../prometheus/prometheus.service';
import { ExternalMetricsStore } from './external-metrics-store';
import {
  attrsToRecord,
  mapDataPoint,
  metricVocabulary,
  nanosToMs,
  pointValue,
  resolveInstanceKey,
} from './otlp-metric-map';
import {
  DROP_REASONS,
  DropReason,
  FieldUpdate,
  OtlpMetric,
  OtlpMetricsRequest,
  OtlpResourceMetrics,
  PartialSuccess,
} from './otlp-metrics-types';

export interface IngestResult {
  accepted: number;
  dropped: Record<DropReason, number>;
}

const WARN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WARN_KEYS = 1000;

function emptyDropCounts(): Record<DropReason, number> {
  return Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>;
}

function isDelta(temporality: number | string | undefined): boolean {
  return temporality === 1 || temporality === 'AGGREGATION_TEMPORALITY_DELTA';
}

function metricPointCount(metric: OtlpMetric): number {
  const points =
    metric.gauge?.dataPoints ??
    metric.sum?.dataPoints ??
    metric.histogram?.dataPoints ??
    metric.exponentialHistogram?.dataPoints ??
    metric.summary?.dataPoints ??
    [];
  return points.length;
}

function resourcePointCount(resourceMetrics: OtlpResourceMetrics): number {
  let count = 0;
  for (const scope of resourceMetrics.scopeMetrics ?? []) {
    for (const metric of scope.metrics ?? []) count += metricPointCount(metric);
  }
  return count;
}

export function toPartialSuccess(result: IngestResult): PartialSuccess | null {
  const reasons = DROP_REASONS.filter((reason) => result.dropped[reason] > 0);
  if (reasons.length === 0) return null;
  return {
    rejectedDataPoints: reasons.reduce((sum, reason) => sum + result.dropped[reason], 0),
    errorMessage: reasons.map((reason) => `${reason}=${result.dropped[reason]}`).join(' '),
  };
}

@Injectable()
export class OtelMetricsIngestService {
  private readonly logger = new Logger(OtelMetricsIngestService.name);
  private readonly lastWarned = new Map<string, number>();

  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly store: ExternalMetricsStore,
    @Optional() private readonly prometheus?: PrometheusService,
  ) {}

  ingest(request: OtlpMetricsRequest, nowMs: number = Date.now()): IngestResult {
    const result: IngestResult = { accepted: 0, dropped: emptyDropCounts() };
    for (const resourceMetrics of request.resourceMetrics ?? []) {
      this.ingestResource(resourceMetrics, nowMs, result);
    }
    this.prometheus?.recordOtlpIngest(result.accepted, result.dropped);
    return result;
  }

  private ingestResource(resourceMetrics: OtlpResourceMetrics, nowMs: number, result: IngestResult): void {
    const attrs = attrsToRecord(resourceMetrics.resource?.attributes);
    const key = resolveInstanceKey(attrs);
    if (!key) {
      this.drop(result, 'unidentified', resourcePointCount(resourceMetrics), 'unidentified resource', nowMs);
      return;
    }
    const instance = `${key.host}:${key.port}`;
    const match = this.registry.findByHostPort(key.host, key.port);
    if (!match) {
      this.drop(result, 'unknown_instance', resourcePointCount(resourceMetrics), instance, nowMs);
      return;
    }
    if (match.connectionType !== 'external') {
      this.drop(result, 'already_polled', resourcePointCount(resourceMetrics), instance, nowMs);
      return;
    }

    const serverVersion = attrs['redis.version'];
    if (serverVersion) this.store.setServerVersion(match.id, serverVersion);
    if (attrs['db.system.name'] === 'valkey') this.store.markValkey(match.id);

    const updates: FieldUpdate[] = [];
    let sawValkeyVocabulary = false;
    for (const scope of resourceMetrics.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        if (this.collectMetric(metric, instance, nowMs, updates, result)) sawValkeyVocabulary = true;
      }
    }
    if (sawValkeyVocabulary) this.store.markValkey(match.id);
    result.accepted += this.store.apply(match.id, updates);
  }

  private collectMetric(
    metric: OtlpMetric,
    instance: string,
    nowMs: number,
    updates: FieldUpdate[],
    result: IngestResult,
  ): boolean {
    if (metric.histogram || metric.exponentialHistogram || metric.summary) {
      this.drop(result, 'unsupported_type', metricPointCount(metric), instance, nowMs);
      return false;
    }
    if (metric.sum && isDelta(metric.sum.aggregationTemporality)) {
      this.drop(result, 'unsupported_temporality', metricPointCount(metric), instance, nowMs);
      return false;
    }

    const name = metric.name ?? '';
    let unmapped = 0;
    let mapped = false;
    for (const dataPoint of metric.gauge?.dataPoints ?? metric.sum?.dataPoints ?? []) {
      const value = pointValue(dataPoint);
      const point = value === null ? null : mapDataPoint(name, attrsToRecord(dataPoint.attributes), value);
      if (point === null) {
        unmapped += 1;
        continue;
      }
      if (point === 'ignored') continue;
      const timeMs = Math.min(nanosToMs(dataPoint.timeUnixNano) ?? nowMs, nowMs);
      updates.push({ target: point.target, value: point.value, timeMs });
      mapped = true;
    }
    this.drop(result, 'unmapped_metric', unmapped, instance, nowMs);
    return mapped && metricVocabulary(name) === 'valkey';
  }

  private drop(result: IngestResult, reason: DropReason, count: number, instance: string, nowMs: number): void {
    if (count <= 0) return;
    result.dropped[reason] += count;
    const key = `${reason}|${instance}`;
    const last = this.lastWarned.get(key);
    if (last !== undefined && nowMs - last < WARN_INTERVAL_MS) return;
    if (this.lastWarned.size >= MAX_WARN_KEYS) this.lastWarned.clear();
    this.lastWarned.set(key, nowMs);
    this.logger.warn(`Dropped ${count} OTLP metric point(s) for ${instance}: ${reason}`);
  }
}
