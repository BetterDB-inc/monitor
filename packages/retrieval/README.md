# @betterdb/retrieval

Developer-facing retrieval SDK over [Valkey Search](https://valkey.io/topics/search/) (`FT.*`): typed index schema, idempotent index lifecycle, upsert/delete, and vector + filtered + hybrid query. Built on [`@betterdb/valkey-search-kit`](../valkey-search-kit/).

## Installation

```bash
npm install @betterdb/retrieval iovalkey
```

Requires a Valkey server with the [Valkey Search](https://valkey.io/topics/search/) module loaded.

## Quick start

```ts
import Valkey from 'iovalkey';
import { Retriever } from '@betterdb/retrieval';

const client = new Valkey('redis://localhost:6379');

const retriever = new Retriever({
  client,
  name: 'docs',
  schema: {
    fields: {
      category: { type: 'tag' },
      year: { type: 'numeric', sortable: true },
    },
    vector: { algorithm: 'hnsw', metric: 'cosine' },
  },
  embedFn: async (text) => embed(text), // returns number[]
});

// Create the index if it doesn't exist (idempotent; dims resolved from embedFn).
await retriever.createIndex();

await retriever.upsert([
  { id: 'doc1', text: 'Valkey is a high-performance key-value store', fields: { category: 'db', year: 2024 } },
]);

const hits = await retriever.query({
  text: 'fast in-memory database',
  k: 5,
  filter: { category: 'db' },
});
```

## Retriever API

- `createIndex()` — create the index if absent (idempotent). Vector dimension is taken from `schema.vector.dims` or resolved by probing `embedFn`.
- `upsert(entries)` — embed each entry's `text` and write it as a hash with its `fields`.
- `delete(ids)` — delete documents by id.
- `query(options)` — KNN search. Provide `text` (embedded for you) or a precomputed `vector`, a positive `k`, an optional `filter` (tag/numeric fields), and `hybrid: 'rerank'` to post-process hits through a `rerankFn`. Returns `QueryHit[]`.
- `describeIndex()` / `health()` — index stats: doc count, indexing state, dimension, percent indexed, and an optional estimated recall.
- `dropIndex()` — drop the index (no-op if it doesn't exist).
- `register()` / `unregister()` — publish/remove a discovery marker in the shared `__betterdb:caches` registry, ownership-checked so it never clobbers a foreign cache type.

> `QueryHit.score` is the raw KNN vector **distance** (lower is closer), not a similarity — rank ascending.

## Observability

Pass a `metrics` (`RetrievalMetrics`) and/or `tracer` (`RetrievalTracer`) to instrument every operation. `createPrometheusMetrics()` provides a ready-made Prometheus implementation.

## License

MIT
