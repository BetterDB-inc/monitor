import { describe, it, expect, vi } from 'vitest';
import { Retriever } from '../retriever';
import type { RetrievalSchema } from '../schema';

const schema: RetrievalSchema = {
  fields: { source: { type: 'tag' } },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
};

const ftInfo = [
  'index_name',
  'docs:idx',
  'num_docs',
  '42',
  'indexing',
  '0',
  'percent_indexed',
  '0.5',
  'attributes',
  [['identifier', 'embedding', 'type', 'VECTOR', 'DIM', '4']],
];

describe('Retriever health', () => {
  it('parses FT.INFO into a health snapshot', async () => {
    const call = vi.fn(async () => ftInfo);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    const health = await retriever.health();

    expect(call).toHaveBeenCalledWith('FT.INFO', 'docs:idx');
    expect(health).toEqual({
      name: 'docs',
      numDocs: 42,
      indexingState: '0',
      dims: 4,
      percentIndexed: 50,
      estimatedRecall: null,
    });
  });

  it('invokes the recallEstimator hook when provided', async () => {
    const call = vi.fn(async () => ftInfo);
    const recallEstimator = vi.fn(() => 0.93);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, recallEstimator });

    const health = await retriever.health();

    expect(recallEstimator).toHaveBeenCalledTimes(1);
    expect(health.estimatedRecall).toBe(0.93);
  });

  it('reports percentIndexed 0 when FT.INFO omits the field', async () => {
    const info = [
      'index_name',
      'docs:idx',
      'num_docs',
      '5',
      'indexing',
      '0',
      'attributes',
      [['identifier', 'embedding', 'type', 'VECTOR', 'DIM', '4']],
    ];
    const call = vi.fn(async () => info);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    const health = await retriever.health();

    expect(health.percentIndexed).toBe(0);
  });

  it("parses valkey-search's backfill_complete_percent fraction", async () => {
    const info = [
      'index_name',
      'docs:idx',
      'num_docs',
      '5',
      'indexing',
      '0',
      'backfill_complete_percent',
      '1.000000',
      'attributes',
      [['identifier', 'embedding', 'type', 'VECTOR', 'DIM', '4']],
    ];
    const call = vi.fn(async () => info);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    const health = await retriever.health();

    expect(health.percentIndexed).toBe(100);
  });

  it('treats a percent_indexed value already in 0-100 range as a percentage', async () => {
    const info = ['index_name', 'docs:idx', 'percent_indexed', '50'];
    const call = vi.fn(async () => info);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    const health = await retriever.health();

    expect(health.percentIndexed).toBe(50);
  });
});
