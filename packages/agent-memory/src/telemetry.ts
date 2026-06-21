import { trace, type Tracer } from '@opentelemetry/api';
import {
  Counter,
  Gauge,
  Histogram,
  register as defaultRegistry,
  Registry,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
} from 'prom-client';

export const DEFAULT_METRICS_PREFIX = 'agent_memory';
export const DEFAULT_TRACER_NAME = '@betterdb/agent-memory';

const RECALL_LATENCY_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];

export interface MemoryTelemetryOptions {
  tracerName?: string;
  metricsPrefix?: string;
  registry?: Registry;
}

export interface MemoryMetrics {
  items: Gauge<string>;
  recallTotal: Counter<string>;
  recallHits: Counter<string>;
  recallEmpty: Counter<string>;
  recallLatency: Histogram<string>;
  embeddingCalls: Counter<string>;
  evictions: Counter<string>;
  consolidations: Counter<string>;
}

export interface MemoryTelemetry {
  tracer: Tracer;
  metrics: MemoryMetrics;
}

function getOrCreateCounter(
  registry: Registry,
  config: CounterConfiguration<string>,
): Counter<string> {
  const existing = registry.getSingleMetric(config.name);
  return existing
    ? (existing as Counter<string>)
    : new Counter({ ...config, registers: [registry] });
}

function getOrCreateGauge(registry: Registry, config: GaugeConfiguration<string>): Gauge<string> {
  const existing = registry.getSingleMetric(config.name);
  return existing ? (existing as Gauge<string>) : new Gauge({ ...config, registers: [registry] });
}

function getOrCreateHistogram(
  registry: Registry,
  config: HistogramConfiguration<string>,
): Histogram<string> {
  const existing = registry.getSingleMetric(config.name);
  return existing
    ? (existing as Histogram<string>)
    : new Histogram({ ...config, registers: [registry] });
}

export function createMemoryTelemetry(options: MemoryTelemetryOptions = {}): MemoryTelemetry {
  const registry = options.registry ?? defaultRegistry;
  const prefix = options.metricsPrefix ?? DEFAULT_METRICS_PREFIX;
  const tracer = trace.getTracer(options.tracerName ?? DEFAULT_TRACER_NAME);
  const labelNames = ['store_name'];

  return {
    tracer,
    metrics: {
      items: getOrCreateGauge(registry, {
        name: `${prefix}_items`,
        help: 'Approximate number of stored memories observed in-process',
        labelNames,
      }),
      recallTotal: getOrCreateCounter(registry, {
        name: `${prefix}_recall_total`,
        help: 'Total recall queries',
        labelNames,
      }),
      recallHits: getOrCreateCounter(registry, {
        name: `${prefix}_recall_hits_total`,
        help: 'Recall queries that returned at least one memory',
        labelNames,
      }),
      recallEmpty: getOrCreateCounter(registry, {
        name: `${prefix}_recall_empty_total`,
        help: 'Recall queries that returned no memories',
        labelNames,
      }),
      recallLatency: getOrCreateHistogram(registry, {
        name: `${prefix}_recall_latency_seconds`,
        help: 'Recall query latency in seconds',
        labelNames,
        buckets: RECALL_LATENCY_BUCKETS,
      }),
      embeddingCalls: getOrCreateCounter(registry, {
        name: `${prefix}_embedding_calls_total`,
        help: 'Total embedding function invocations',
        labelNames,
      }),
      evictions: getOrCreateCounter(registry, {
        name: `${prefix}_evictions_total`,
        help: 'Total memories evicted for capacity',
        labelNames,
      }),
      consolidations: getOrCreateCounter(registry, {
        name: `${prefix}_consolidations_total`,
        help: 'Total consolidation summaries created',
        labelNames,
      }),
    },
  };
}
