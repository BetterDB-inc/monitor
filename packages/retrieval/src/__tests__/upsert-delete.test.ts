import { describe, it, expect, vi } from 'vitest';
import { encodeFloat32 } from '@betterdb/valkey-search-kit';
import { Retriever } from '../retriever';
import { buildFtCreateArgs } from '../ft-create';
import type { RetrievalSchema } from '../schema';

const schemaWithDims: RetrievalSchema = {
  fields: { source: { type: 'tag' }, updated: { type: 'numeric' } },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: 4 },
};

const schemaNoDims: RetrievalSchema = {
  fields: { source: { type: 'tag' } },
  vector: { metric: 'cosine', algorithm: 'hnsw' },
};

function indexNotFoundError(): Error {
  return new Error("Unknown index name 'docs:idx'");
}

function fakeEmbed(dims: number): (text: string) => Promise<number[]> {
  return async () => new Array(dims).fill(0.5);
}

describe('Retriever dimension inference', () => {
  it('probes embedFn for dims when the schema omits dims', async () => {
    const embedFn = vi.fn(fakeEmbed(16));
    const call = vi.fn(async (command: string) => {
      if (command === 'FT.INFO') {
        throw indexNotFoundError();
      }
      return 'OK';
    });
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaNoDims,
      embedFn,
    });

    await retriever.createIndex();

    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'FT.CREATE',
      ...buildFtCreateArgs('docs', {
        ...schemaNoDims,
        vector: { ...schemaNoDims.vector, dims: 16 },
      }),
    );
  });

  it('throws when neither schema.dims nor embedFn is available', async () => {
    const call = vi.fn(async (command: string) => {
      if (command === 'FT.INFO') {
        throw indexNotFoundError();
      }
      return 'OK';
    });
    const retriever = new Retriever({ client: { call }, name: 'docs', schema: schemaNoDims });

    await expect(retriever.createIndex()).rejects.toThrow(
      /provide schema\.vector\.dims or an embedFn/,
    );
  });
});

describe('Retriever upsert', () => {
  it('embeds text and HSETs the entry hash with fields, vector, and __text', async () => {
    const vec = [0.1, 0.2, 0.3, 0.4];
    const embedFn = vi.fn(async () => vec);
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await retriever.upsert([
      { id: 'doc:1', text: 'hello world', fields: { source: 'docs', updated: 1717200000 } },
    ]);

    expect(embedFn).toHaveBeenCalledWith('hello world');
    expect(call).toHaveBeenCalledWith(
      'HSET',
      'docs:doc:1',
      'source',
      'docs',
      'updated',
      '1717200000',
      'embedding',
      encodeFloat32(vec),
      '__text',
      'hello world',
    );
  });

  it('throws when upserting without an embedFn', async () => {
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({ client: { call }, name: 'docs', schema: schemaWithDims });

    await expect(retriever.upsert([{ id: 'doc:1', text: 'x', fields: {} }])).rejects.toThrow(
      /embedFn/,
    );

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(0);
  });

  it('throws when the embedding length does not match the resolved dims', async () => {
    const embedFn = vi.fn(async () => [0.1, 0.2]);
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await expect(retriever.upsert([{ id: 'doc:1', text: 'x', fields: {} }])).rejects.toThrow(
      /dimension/i,
    );

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(0);
  });

  it('HSETs one hash per entry', async () => {
    const embedFn = vi.fn(fakeEmbed(4));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await retriever.upsert([
      { id: 'a', text: 'first', fields: { source: 'docs', updated: 1 } },
      { id: 'b', text: 'second', fields: { source: 'docs', updated: 2 } },
    ]);

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(2);
    expect(hsetCalls[0][1]).toBe('docs:a');
    expect(hsetCalls[1][1]).toBe('docs:b');
  });

  it('issues no commands for an empty entry list', async () => {
    const embedFn = vi.fn(fakeEmbed(4));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await retriever.upsert([]);

    expect(call).not.toHaveBeenCalled();
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('rejects entry fields colliding with the reserved __text field', async () => {
    const embedFn = vi.fn(fakeEmbed(4));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await expect(
      retriever.upsert([{ id: 'doc:1', text: 'x', fields: { __text: 'oops' } }]),
    ).rejects.toThrow(/reserved/i);

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(0);
  });

  it('rejects entry fields colliding with the vector field name', async () => {
    const embedFn = vi.fn(fakeEmbed(4));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await expect(
      retriever.upsert([{ id: 'doc:1', text: 'x', fields: { embedding: 'oops' } }]),
    ).rejects.toThrow(/reserved/i);

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(0);
  });

  it('rejects an entry field named __score', async () => {
    const embedFn = vi.fn(fakeEmbed(4));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await expect(
      retriever.upsert([{ id: 'doc:1', text: 'x', fields: { __score: 'oops' } }]),
    ).rejects.toThrow(/reserved/i);

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(0);
  });

  it('probes embedFn once and caches dims across multiple entries', async () => {
    const embedFn = vi.fn(fakeEmbed(8));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaNoDims,
      embedFn,
    });

    await retriever.upsert([
      { id: 'a', text: 'first', fields: { source: 'docs' } },
      { id: 'b', text: 'second', fields: { source: 'docs' } },
    ]);

    expect(embedFn).toHaveBeenCalledTimes(3);
    expect(embedFn).toHaveBeenNthCalledWith(1, 'probe');
  });

  it('throws when the embedFn probe returns a zero-length vector', async () => {
    const embedFn = vi.fn(async () => []);
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaNoDims,
      embedFn,
    });

    await expect(
      retriever.upsert([{ id: 'doc:1', text: 'x', fields: { source: 'docs' } }]),
    ).rejects.toThrow(/dimension/i);

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(0);
  });

  it('throws when schema.vector.dims is a non-positive value', async () => {
    const schemaBadDims: RetrievalSchema = {
      fields: { source: { type: 'tag' } },
      vector: { metric: 'cosine', algorithm: 'hnsw', dims: 0 },
    };
    const embedFn = vi.fn(fakeEmbed(4));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaBadDims,
      embedFn,
    });

    await expect(
      retriever.upsert([{ id: 'doc:1', text: 'x', fields: { source: 'docs' } }]),
    ).rejects.toThrow(/dims/i);

    expect(embedFn).not.toHaveBeenCalled();
  });

  it('does not write any entry when a later entry in the batch is invalid', async () => {
    const embedFn = vi.fn(fakeEmbed(4));
    const call = vi.fn(async () => 'OK');
    const retriever = new Retriever({
      client: { call },
      name: 'docs',
      schema: schemaWithDims,
      embedFn,
    });

    await expect(
      retriever.upsert([
        { id: 'good', text: 'first', fields: { source: 'docs' } },
        { id: 'bad', text: 'second', fields: { __text: 'oops' } },
      ]),
    ).rejects.toThrow(/reserved/i);

    const hsetCalls = call.mock.calls.filter((args) => args[0] === 'HSET');
    expect(hsetCalls).toHaveLength(0);
  });
});

describe('Retriever delete', () => {
  it('DELs the derived keys for the given ids', async () => {
    const call = vi.fn(async () => 2);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema: schemaWithDims });

    await retriever.delete(['doc:1', 'doc:2']);

    expect(call).toHaveBeenCalledWith('DEL', 'docs:doc:1', 'docs:doc:2');
  });

  it('issues no command for an empty id list', async () => {
    const call = vi.fn(async () => 0);
    const retriever = new Retriever({ client: { call }, name: 'docs', schema: schemaWithDims });

    await retriever.delete([]);

    expect(call).not.toHaveBeenCalled();
  });
});
