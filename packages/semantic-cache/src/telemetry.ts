import { trace, type Tracer } from '@opentelemetry/api';
import {
  Counter,
  Histogram,
  Registry,
  register as defaultRegistry,
  type CounterConfiguration,
  type HistogramConfiguration,
} from 'prom-client';

interface TelemetryFactoryOptions {
  prefix: string;
  tracerName: string;
  registry?: Registry;
}

interface CacheMetrics {
  requestsTotal: Counter;
  similarityScore: Histogram;
  operationDuration: Histogram;
  embeddingDuration: Histogram;
}

export interface Telemetry {
  tracer: Tracer;
  metrics: CacheMetrics;
}

function getOrCreateCounter(
  registry: Registry,
  config: CounterConfiguration<string>,
): Counter {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Counter;
  return new Counter({ ...config, registers: [registry] });
}

function getOrCreateHistogram(
  registry: Registry,
  config: HistogramConfiguration<string>,
): Histogram {
  const existing = registry.getSingleMetric(config.name);
  if (existing) return existing as Histogram;
  return new Histogram({ ...config, registers: [registry] });
}

export function createTelemetry(opts: TelemetryFactoryOptions): Telemetry {
  const registry = opts.registry ?? defaultRegistry;
  const tracer = trace.getTracer(opts.tracerName);

  const operationBuckets = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0];

  const requestsTotal = getOrCreateCounter(registry, {
    name: `${opts.prefix}_requests_total`,
    help: 'Total number of semantic cache requests',
    labelNames: ['cache_name', 'result', 'category'],
  });

  const similarityScore = getOrCreateHistogram(registry, {
    name: `${opts.prefix}_similarity_score`,
    help: 'Cosine distance similarity scores for cache lookups',
    labelNames: ['cache_name', 'category'],
    buckets: [0.02, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2, 0.3, 0.5, 1.0, 2.0],
  });

  const operationDuration = getOrCreateHistogram(registry, {
    name: `${opts.prefix}_operation_duration_seconds`,
    help: 'Duration of semantic cache operations in seconds',
    labelNames: ['cache_name', 'operation'],
    buckets: operationBuckets,
  });

  const embeddingDuration = getOrCreateHistogram(registry, {
    name: `${opts.prefix}_embedding_duration_seconds`,
    help: 'Duration of embedding function calls in seconds',
    labelNames: ['cache_name'],
    buckets: operationBuckets,
  });

  return {
    tracer,
    metrics: {
      requestsTotal,
      similarityScore,
      operationDuration,
      embeddingDuration,
    },
  };
}
