import { describe, it, expect } from 'vitest';
import { Registry } from 'prom-client';
import { createPrometheusMetrics } from '../prometheus-metrics';

describe('createPrometheusMetrics', () => {
  it('records operations, query results, and embedding calls into the registry', async () => {
    const registry = new Registry();
    const metrics = createPrometheusMetrics({ registry });

    metrics.observeOperation('query', 0.02);
    metrics.recordQueryResults(3);
    metrics.recordEmbeddingCall();
    metrics.recordEmbeddingCall();

    const json = await registry.getMetricsAsJSON();

    const embedding = json.find((m) => m.name === 'retrieval_embedding_calls_total');
    expect(embedding?.values[0]?.value).toBe(2);

    const duration = json.find((m) => m.name === 'retrieval_operation_duration_seconds');
    const queryLabel = duration?.values.find((v) => v.labels.operation === 'query');
    expect(queryLabel).toBeDefined();

    const results = json.find((m) => m.name === 'retrieval_query_results');
    expect(results).toBeDefined();
  });

  it('honors a custom metric prefix', async () => {
    const registry = new Registry();
    createPrometheusMetrics({ registry, prefix: 'docs_idx' });

    const json = await registry.getMetricsAsJSON();
    expect(json.some((m) => m.name === 'docs_idx_operation_duration_seconds')).toBe(true);
  });

  it('is safe to construct twice against the same registry and prefix', async () => {
    const registry = new Registry();
    createPrometheusMetrics({ registry });
    const second = createPrometheusMetrics({ registry });

    second.recordEmbeddingCall();

    const json = await registry.getMetricsAsJSON();
    const embedding = json.find((m) => m.name === 'retrieval_embedding_calls_total');
    expect(embedding?.values[0]?.value).toBe(1);
  });
});
