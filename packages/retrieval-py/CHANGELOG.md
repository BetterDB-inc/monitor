# Changelog

## [0.1.0] - 2026-06-23

### Added

- Initial release. Python equivalent of the TypeScript `@betterdb/retrieval`.
- `Retriever` — index lifecycle (`create_index` / `drop_index` / `describe_index` / `health`), `upsert` / `delete`, and `query` (vector + filtered + `hybrid="rerank"` KNN search).
- Typed `RetrievalSchema` (tag / numeric / text fields, HNSW & FLAT vector specs).
- Shared discovery registry `register` / `unregister`, ownership-checked against the `__betterdb:caches` hash.
- Observability seams: `RetrievalMetrics` / `RetrievalTracer` protocols and `create_prometheus_metrics` (optional `prometheus` extra).
