import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import Valkey from 'iovalkey';
import { Retriever } from '../retriever';
import type { EmbedFn } from '../retriever';
import type { RetrievalSchema } from '../schema';
import { REGISTRY_KEY } from '../discovery';

const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://:devpassword@localhost:6384';
const DIM = 8;

const fakeEmbed: EmbedFn = async (text: string) => {
  const hash = createHash('sha256').update(text).digest('hex');
  const vec = Array.from(
    { length: DIM },
    (_, i) => parseInt(hash.slice(i * 2, i * 2 + 2), 16) / 255,
  );
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
};

const schema: RetrievalSchema = {
  fields: {
    source: { type: 'tag' },
    rank: { type: 'numeric', sortable: true },
  },
  vector: { metric: 'cosine', algorithm: 'hnsw', dims: DIM },
};

const docs = [
  { id: 'doc:1', text: 'valkey vector search overview', fields: { source: 'docs', rank: 1 } },
  { id: 'doc:2', text: 'agent memory and retrieval', fields: { source: 'docs', rank: 2 } },
  { id: 'post:1', text: 'a blog about databases', fields: { source: 'blog', rank: 3 } },
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function pollUntil(predicate: () => Promise<boolean>, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

let client: Valkey;
let retriever: Retriever;
let name: string;
let skip = false;

beforeAll(async () => {
  client = new Valkey(VALKEY_URL, { lazyConnect: true, retryStrategy: () => null });
  try {
    await client.connect();
    await client.ping();
    // The search module is required for FT.* — skip gracefully if it is absent.
    await client.call('FT._LIST');
  } catch {
    skip = true;
    client.on('error', () => {});
    return;
  }

  name = `retrieval_int_${Date.now()}`;
  retriever = new Retriever({ client, name, schema, embedFn: fakeEmbed });
  await retriever.createIndex();
  await retriever.createIndex();

  await retriever.upsert(docs);

  // HNSW indexing is asynchronous; wait until every document is queryable.
  for (const doc of docs) {
    const indexed = await pollUntil(async () => {
      const hits = await retriever.query({ text: doc.text, k: 5 });
      return hits.some((hit) => hit.id === doc.id);
    });
    if (!indexed) {
      throw new Error(`Document ${doc.id} was not indexed within the timeout`);
    }
  }
});

afterAll(async () => {
  if (!skip) {
    await retriever.dropIndex().catch(() => {});
  }
  await client.quit().catch(() => {});
});

describe('Retriever integration', () => {
  it('returns the upserted document for a matching vector query', async () => {
    if (skip) return;

    const hits = await retriever.query({ text: 'valkey vector search overview', k: 5 });

    expect(hits[0]?.id).toBe('doc:1');
  });

  it('returns the full hit shape with fields and text', async () => {
    if (skip) return;

    const hits = await retriever.query({ text: 'valkey vector search overview', k: 1 });

    expect(hits[0]?.id).toBe('doc:1');
    expect(hits[0]?.text).toBe('valkey vector search overview');
    expect(hits[0]?.fields.source).toBe('docs');
    expect(hits[0]?.fields.rank).toBe('1');
    expect(Number.isFinite(hits[0]?.score)).toBe(true);
  });

  it('queries by a precomputed vector and skips the embedFn', async () => {
    if (skip) return;

    const vector = await fakeEmbed('valkey vector search overview');
    const hits = await retriever.query({ vector, k: 1 });

    expect(hits[0]?.id).toBe('doc:1');
  });

  it('narrows results with a TAG filter', async () => {
    if (skip) return;

    const hits = await retriever.query({
      text: 'a blog about databases',
      k: 5,
      filter: { source: 'blog' },
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.id === 'post:1')).toBe(true);
  });

  it('narrows results with a NUMERIC filter', async () => {
    if (skip) return;

    const hits = await retriever.query({
      text: 'agent memory and retrieval',
      k: 5,
      filter: { rank: 2 },
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.id === 'doc:2')).toBe(true);
  });

  it('registers and unregisters a discovery marker', async () => {
    if (skip) return;

    await retriever.register();
    const raw = await client.hget(REGISTRY_KEY, name);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).type).toBe('retrieval');

    await retriever.unregister();
    expect(await client.hget(REGISTRY_KEY, name)).toBeNull();
  });

  it('reports health with document count and indexing progress', async () => {
    if (skip) return;

    // Backfill progress is reported asynchronously; wait for it to advance.
    const progressed = await pollUntil(async () => {
      return (await retriever.health()).percentIndexed > 0;
    });
    expect(progressed).toBe(true);

    const health = await retriever.health();
    expect(health.name).toBe(name);
    expect(health.dims).toBe(DIM);
    expect(health.numDocs).toBeGreaterThan(0);
    expect(health.percentIndexed).toBeGreaterThan(0);
  });

  it('removes a document with delete', async () => {
    if (skip) return;

    await retriever.delete(['doc:2']);

    // Deletion propagates to the HNSW index asynchronously.
    const gone = await pollUntil(async () => {
      const hits = await retriever.query({ text: 'agent memory and retrieval', k: 5 });
      return hits.every((hit) => hit.id !== 'doc:2');
    });

    expect(gone).toBe(true);
  });

  it('dropIndex removes the index so describeIndex fails', async () => {
    if (skip) return;

    const dropName = `retrieval_drop_${Date.now()}`;
    const throwaway = new Retriever({ client, name: dropName, schema, embedFn: fakeEmbed });
    await throwaway.createIndex();
    await throwaway.dropIndex();

    await expect(throwaway.describeIndex()).rejects.toThrow();
  });
});
