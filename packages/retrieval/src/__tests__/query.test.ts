import { describe, it, expect, vi } from 'vitest';
import { encodeFloat32 } from '@betterdb/valkey-search-kit';
import { Retriever } from '../retriever';
import type { RetrievalSchema } from '../schema';
import type { QueryHit } from '../retriever';

const schema: RetrievalSchema = {
  fields: { source: { type: 'tag' }, updated: { type: 'numeric' } },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
};

interface Row {
  key: string;
  fields: Record<string, string>;
}

function searchReply(rows: Row[]): unknown[] {
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

describe('Retriever query', () => {
  it('embeds the text, runs FT.SEARCH, and maps rows to hits', async () => {
    const vec = [0.1, 0.2, 0.3, 0.4];
    const embedFn = vi.fn(async () => vec);
    const reply = searchReply([
      {
        key: 'docs:doc:1',
        fields: {
          source: 'docs',
          updated: '1717200000',
          __text: 'hello world',
          __score: '0.12',
          embedding: 'rawbytes',
        },
      },
    ]);
    const call = vi.fn(async () => reply);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn });

    const hits = await retriever.query({ text: 'hi', k: 10, filter: { source: 'docs' } });

    expect(embedFn).toHaveBeenCalledWith('hi');
    expect(call).toHaveBeenCalledWith(
      'FT.SEARCH',
      'docs:idx',
      '(@source:{docs})=>[KNN 10 @embedding $vec AS __score]',
      'PARAMS',
      '2',
      'vec',
      encodeFloat32(vec),
      'LIMIT',
      '0',
      '10',
      'DIALECT',
      '2',
    );
    const expected: QueryHit[] = [
      {
        id: 'doc:1',
        score: 0.12,
        text: 'hello world',
        fields: { source: 'docs', updated: '1717200000' },
      },
    ];
    expect(hits).toEqual(expected);
  });

  it('uses a precomputed vector and does not call embedFn', async () => {
    const vec = [0.5, 0.5, 0.5, 0.5];
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn });

    await retriever.query({ vector: vec, k: 5 });

    expect(embedFn).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledWith(
      'FT.SEARCH',
      'docs:idx',
      '*=>[KNN 5 @embedding $vec AS __score]',
      'PARAMS',
      '2',
      'vec',
      encodeFloat32(vec),
      'LIMIT',
      '0',
      '5',
      'DIALECT',
      '2',
    );
  });

  it('throws when both text and vector are provided', async () => {
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn });

    await expect(retriever.query({ text: 'a', vector: [1, 2, 3, 4], k: 5 })).rejects.toThrow(
      /both/i,
    );

    expect(call).not.toHaveBeenCalled();
  });

  it('throws when neither text nor vector is provided', async () => {
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await expect(retriever.query({ k: 5 })).rejects.toThrow(/text or/i);

    expect(call).not.toHaveBeenCalled();
  });

  it('returns an empty array when FT.SEARCH yields no hits', async () => {
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn });

    const hits = await retriever.query({ text: 'x', k: 5 });

    expect(hits).toEqual([]);
  });

  it('reorders hits via rerankFn when hybrid is rerank', async () => {
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const reply = searchReply([
      { key: 'docs:a', fields: { __text: 'first', __score: '0.9', source: 'docs' } },
      { key: 'docs:b', fields: { __text: 'second', __score: '0.8', source: 'docs' } },
    ]);
    const call = vi.fn(async () => reply);
    const rerankFn = vi.fn(async (_queryText: string, hits: QueryHit[]) => [...hits].reverse());
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn, rerankFn });

    const hits = await retriever.query({ text: 'q', k: 5, hybrid: 'rerank' });

    const passedHits = rerankFn.mock.calls[0][1];
    expect(passedHits).toEqual([
      { id: 'a', score: 0.9, text: 'first', fields: { source: 'docs' } },
      { id: 'b', score: 0.8, text: 'second', fields: { source: 'docs' } },
    ]);
    expect(hits.map((h) => h.id)).toEqual(['b', 'a']);
  });

  it('throws for hybrid rerank without a rerankFn', async () => {
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn });

    await expect(retriever.query({ text: 'q', k: 5, hybrid: 'rerank' })).rejects.toThrow(
      /rerankFn/,
    );

    expect(call).not.toHaveBeenCalled();
  });

  it('throws for hybrid rerank without text', async () => {
    const rerankFn = vi.fn(async (_q: string, hits: QueryHit[]) => hits);
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, rerankFn });

    await expect(retriever.query({ vector: [1, 2, 3, 4], k: 5, hybrid: 'rerank' })).rejects.toThrow(
      /text/i,
    );

    expect(call).not.toHaveBeenCalled();
  });

  it('throws when k is not a positive integer', async () => {
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema, embedFn });

    await expect(retriever.query({ text: 'x', k: 0 })).rejects.toThrow(/positive integer/i);

    expect(call).not.toHaveBeenCalled();
  });

  it('throws when a precomputed vector has the wrong dimension', async () => {
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema });

    await expect(retriever.query({ vector: [1, 2], k: 5 })).rejects.toThrow(/dimension/i);

    expect(call).not.toHaveBeenCalled();
  });

  it('rejects a precomputed vector that mismatches the inferred (cached) dimension', async () => {
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const noDims: RetrievalSchema = {
      fields: { source: { type: 'tag' } },
      vector: { metric: 'cosine', algorithm: 'hnsw' },
    };
    const call = vi.fn(async (command: string) => {
      if (command === 'FT.INFO') {
        throw new Error("Unknown index name 'docs:idx'");
      }
      return searchReply([]);
    });
    const retriever = new Retriever({ client: { call }, name: 'docs', schema: noDims, embedFn });

    await retriever.createIndex();

    await expect(retriever.query({ vector: [1, 2], k: 5 })).rejects.toThrow(/dimension/i);
    const searchCalls = call.mock.calls.filter((args) => args[0] === 'FT.SEARCH');
    expect(searchCalls).toHaveLength(0);
  });

  it('rejects a precomputed vector against inferred dims before the index is created', async () => {
    const embedFn = vi.fn(async () => [0, 0, 0, 0]);
    const noDims: RetrievalSchema = {
      fields: { source: { type: 'tag' } },
      vector: { metric: 'cosine', algorithm: 'hnsw' },
    };
    const call = vi.fn(async () => searchReply([]));
    const retriever = new Retriever({ client: { call }, name: 'docs', schema: noDims, embedFn });

    await expect(retriever.query({ vector: [1, 2], k: 5 })).rejects.toThrow(/dimension/i);

    const searchCalls = call.mock.calls.filter((args) => args[0] === 'FT.SEARCH');
    expect(searchCalls).toHaveLength(0);
  });
});
