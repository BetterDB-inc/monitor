import { Injectable } from '@nestjs/common';
import { Feature } from '@betterdb/shared';
import {
  KvCacheOtlpSink,
  KvCacheOtlpSinkResult,
  LMCACHE_ENGINE_ATTRIBUTE,
} from '@app/external-metrics/kv-cache-otlp-sink';
import { attrsToRecord, isDeltaTemporality, nanosToMs, NO_RECORDED_VALUE, pointValue } from '@app/external-metrics/otlp-metric-map';
import type { DropReason, OtlpMetric } from '@app/external-metrics/otlp-metrics-types';
import { LicenseService } from '@proprietary/licenses/license.service';
import { METRIC_FIELDS } from './counter-deltas';
import { KvCacheEngineRegistry } from './kv-cache-engine-registry';
import { KvCacheSamplesService } from './kv-cache-samples.service';

function pointsOf(metric: OtlpMetric): number {
  const points =
    metric.gauge?.dataPoints ??
    metric.sum?.dataPoints ??
    metric.histogram?.dataPoints ??
    metric.exponentialHistogram?.dataPoints ??
    metric.summary?.dataPoints ??
    [];
  return points.length;
}

@Injectable()
export class KvCacheOtlpSinkService implements KvCacheOtlpSink {
  constructor(
    private readonly registry: KvCacheEngineRegistry,
    private readonly samples: KvCacheSamplesService,
    private readonly license: LicenseService,
  ) {}

  ingest(resourceAttributes: Record<string, string>, metrics: OtlpMetric[], nowMs: number): KvCacheOtlpSinkResult {
    const engineKey = resourceAttributes[LMCACHE_ENGINE_ATTRIBUTE];
    const engine =
      engineKey !== undefined && this.license.hasFeature(Feature.KV_CACHE_MONITORING)
        ? this.registry.byOtlpId(engineKey)
        : null;
    if (!engine || !engine.enabled) {
      const total = metrics.reduce((sum, metric) => sum + pointsOf(metric), 0);
      return { accepted: 0, dropped: total > 0 ? { unknown_engine: total } : {} };
    }

    const dropped: Partial<Record<DropReason, number>> = {};
    const addDrop = (reason: DropReason, count: number) => {
      if (count > 0) dropped[reason] = (dropped[reason] ?? 0) + count;
    };
    let accepted = 0;

    for (const metric of metrics) {
      const name = (metric.name ?? '').replace(/^lmcache:/, '').replace(/_total$/, '');
      if (!metric.sum) {
        addDrop('unsupported_type', pointsOf(metric));
        continue;
      }
      if (!Object.hasOwn(METRIC_FIELDS, name)) {
        addDrop('unmapped_metric', pointsOf(metric));
        continue;
      }
      const cumulative = !isDeltaTemporality(metric.sum.aggregationTemporality);
      for (const dataPoint of metric.sum.dataPoints ?? []) {
        if ((dataPoint.flags ?? 0) & NO_RECORDED_VALUE) continue;
        const raw = pointValue(dataPoint);
        const value = raw === null ? NaN : Number(raw);
        if (!Number.isFinite(value)) {
          addDrop('invalid_value', 1);
          continue;
        }
        const labels = attrsToRecord(dataPoint.attributes);
        this.samples.observe(
          {
            engineId: engine.id,
            connectionId: engine.connectionId,
            modelName: labels.model_name || 'unknown',
            series: `${labels.worker_id ?? ''}|${labels.role ?? ''}`,
            metric: name,
            value,
            cumulative,
            startMs: dataPoint.startTimeUnixNano ? (nanosToMs(dataPoint.startTimeUnixNano) ?? undefined) : undefined,
          },
          nowMs,
        );
        accepted += 1;
      }
    }

    if (accepted > 0) this.registry.recordResult(engine.id, { lastSeenAt: nowMs, lastError: null });
    return { accepted, dropped };
  }
}
