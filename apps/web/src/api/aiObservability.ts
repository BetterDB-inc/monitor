import { fetchApi } from './client';
import type {
  AiInstance,
  StoredAiCacheSample,
  OtelTraceSummary,
  StoredOtelSpan,
  SpanCorrelation,
} from '@betterdb/shared';

export interface AiInstanceWithSample {
  instance: AiInstance;
  latest: StoredAiCacheSample | null;
}

export const aiObservabilityApi = {
  /** Discovered AI cache/memory instances on the current connection + their latest sample. */
  getInstances: () =>
    fetchApi<{ instances: AiInstanceWithSample[] }>('/ai/instances').then((r) => r.instances),

  /** Time-series history for one instance. */
  getHistory: (field: string, hours = 24) =>
    fetchApi<{ samples: StoredAiCacheSample[] }>(
      `/ai/instances/${encodeURIComponent(field)}/history?hours=${hours}`,
    ).then((r) => r.samples),

  /** Recent ingested traces (OTLP) with per-trace summary. */
  getTraces: (hours = 1, limit = 100) =>
    fetchApi<{ traces: OtelTraceSummary[] }>(`/ai/traces?hours=${hours}&limit=${limit}`).then(
      (r) => r.traces,
    ),

  /** All stored spans for one trace (for the waterfall). */
  getTraceSpans: (traceId: string) =>
    fetchApi<{ spans: StoredOtelSpan[] }>(`/ai/traces/${encodeURIComponent(traceId)}`).then(
      (r) => r.spans,
    ),

  /** Correlate a trace's BetterDB spans with live Valkey state. */
  getTraceCorrelations: (traceId: string) =>
    fetchApi<{ correlations: SpanCorrelation[] }>(
      `/ai/traces/${encodeURIComponent(traceId)}/correlate`,
    ).then((r) => r.correlations),
};
