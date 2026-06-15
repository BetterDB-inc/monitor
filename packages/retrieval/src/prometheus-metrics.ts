import {
  Counter,
  Histogram,
  type CounterConfiguration,
  type HistogramConfiguration,
  type Registry,
} from 'prom-client';
import type { RetrievalMetrics, RetrievalOperation } from './telemetry';

export interface PrometheusMetricsOptions {
  registry: Registry;
  prefix?: string;
}

function getOrCreateHistogram(
  registry: Registry,
  config: HistogramConfiguration<string>,
): Histogram {
  const existing = registry.getSingleMetric(config.name);
  if (existing !== undefined) {
    return existing as Histogram;
  }
  return new Histogram({ ...config, registers: [registry] });
}

function getOrCreateCounter(registry: Registry, config: CounterConfiguration<string>): Counter {
  const existing = registry.getSingleMetric(config.name);
  if (existing !== undefined) {
    return existing as Counter;
  }
  return new Counter({ ...config, registers: [registry] });
}

export function createPrometheusMetrics(options: PrometheusMetricsOptions): RetrievalMetrics {
  const prefix = options.prefix ?? 'retrieval';
  const registry = options.registry;

  const operationDuration = getOrCreateHistogram(registry, {
    name: `${prefix}_operation_duration_seconds`,
    help: 'Duration of retrieval operations in seconds',
    labelNames: ['operation'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0],
  });

  const queryResults = getOrCreateHistogram(registry, {
    name: `${prefix}_query_results`,
    help: 'Number of hits returned per query',
    buckets: [0, 1, 5, 10, 25, 50, 100],
  });

  const embeddingCalls = getOrCreateCounter(registry, {
    name: `${prefix}_embedding_calls_total`,
    help: 'Total number of embedding function calls',
  });

  return {
    observeOperation(operation: RetrievalOperation, seconds: number): void {
      operationDuration.labels(operation).observe(seconds);
    },
    recordQueryResults(count: number): void {
      queryResults.observe(count);
    },
    recordEmbeddingCall(): void {
      embeddingCalls.inc();
    },
  };
}
