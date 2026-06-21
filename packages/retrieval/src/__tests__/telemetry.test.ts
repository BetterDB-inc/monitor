import { describe, it, expect, vi } from 'vitest';
import { Retriever } from '../retriever';
import type { RetrievalMetrics, RetrievalTracer } from '../telemetry';
import type { RetrievalSchema } from '../schema';

const schema: RetrievalSchema = {
  fields: { source: { type: 'tag' } },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
};

function fakeMetrics(): RetrievalMetrics {
  return {
    observeOperation: vi.fn(),
    recordQueryResults: vi.fn(),
    recordEmbeddingCall: vi.fn(),
  };
}

function searchReply(rows: { key: string; fields: Record<string, string> }[]): unknown[] {
  const out: unknown[] = [String(rows.length)];
  for (const row of rows) {
    out.push(row.key);
    const flat: string[] = [];
    for (const [field, value] of Object.entries(row.fields)) {
      flat.push(field, value);
    }
    out.push(flat);
  }
  return out;
}

describe('Retriever telemetry', () => {
  it('records metrics for a query', async () => {
    const metrics = fakeMetrics();
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const reply = searchReply([
      { key: 'docs:doc:1', fields: { __score: '0.1', __text: 't', source: 'docs' } },
    ]);
    const call = vi.fn(async () => reply);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn, metrics });

    await retriever.query({ text: 'q', k: 5 });

    expect(metrics.observeOperation).toHaveBeenCalledWith('query', expect.any(Number));
    expect(metrics.recordQueryResults).toHaveBeenCalledWith(1);
    expect(metrics.recordEmbeddingCall).toHaveBeenCalledTimes(1);
  });

  it('records metrics for an upsert', async () => {
    const metrics = fakeMetrics();
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn, metrics });

    await retriever.upsert([
      { id: 'a', text: 'x', fields: { source: 'docs' } },
      { id: 'b', text: 'y', fields: { source: 'docs' } },
    ]);

    expect(metrics.observeOperation).toHaveBeenCalledWith('upsert', expect.any(Number));
    expect(metrics.recordEmbeddingCall).toHaveBeenCalledTimes(2);
  });

  it('opens and closes a span via the tracer for a query', async () => {
    const end = vi.fn();
    const startSpan = vi.fn(() => ({ end }));
    const tracer: RetrievalTracer = { startSpan };
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn, tracer });

    await retriever.query({ text: 'q', k: 5 });

    expect(startSpan).toHaveBeenCalledWith('retrieval.query');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('records duration and ends the span even when the query throws', async () => {
    const metrics = fakeMetrics();
    const end = vi.fn();
    const tracer: RetrievalTracer = { startSpan: vi.fn(() => ({ end })) };
    const embedFn = vi.fn(async () => {
      throw new Error('embed boom');
    });
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema,
      embedFn,
      metrics,
      tracer,
    });

    await expect(retriever.query({ text: 'q', k: 5 })).rejects.toThrow('embed boom');

    expect(metrics.observeOperation).toHaveBeenCalledWith('query', expect.any(Number));
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('counts the dims-probe embedding call', async () => {
    const metrics = fakeMetrics();
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const noDims: RetrievalSchema = {
      fields: { source: { type: 'tag' } },
      vector: { metric: 'cosine', algorithm: 'hnsw' },
    };
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: noDims,
      embedFn,
      metrics,
    });

    await retriever.query({ text: 'q', k: 5 });

    expect(metrics.recordEmbeddingCall).toHaveBeenCalledTimes(2);
  });
});
