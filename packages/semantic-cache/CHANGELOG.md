# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-21

### Added

- `SemanticCache` class — standalone, framework-agnostic semantic cache for LLM applications backed by Valkey via the `valkey-search` module
- `check(prompt, options?)` — vector similarity lookup returning hit/miss with similarity score, confidence level (`high` | `uncertain` | `miss`), and nearest-miss diagnostics on threshold failures
- `store(prompt, response, options?)` — stores prompt/response pairs with per-entry TTL, category tag, and model tag
- `invalidate(filter)` — batch delete by `valkey-search` filter expression (e.g. `@model:{gpt-4o}`); single `DEL` call for all matching keys
- `stats()` — hit/miss/total counts and hit rate, persisted in Valkey so BetterDB Monitor can poll them independently
- `indexInfo()` — returns index metadata from `FT.INFO`
- `flush()` — drops the FT index and cleans up all entry keys via `SCAN` + `DEL`
- Per-category threshold overrides via `categoryThresholds` option
- Uncertainty band: hits within `uncertaintyBand` of the threshold are flagged `confidence: 'uncertain'`
- Sliding TTL refresh on cache hits when `defaultTtl` is set
- Built-in OpenTelemetry spans on every operation (`semantic_cache.check`, `semantic_cache.store`, `semantic_cache.invalidate`, `semantic_cache.initialize`) with `cache.hit`, `cache.similarity`, `cache.threshold`, `cache.confidence`, `cache.category` attributes
- Four Prometheus metrics via `prom-client`: `{prefix}_requests_total`, `{prefix}_similarity_score`, `{prefix}_operation_duration_seconds`, `{prefix}_embedding_duration_seconds`
- Optional `telemetry.registry` parameter to isolate metrics from the host application's default prom-client registry
- Typed error classes: `SemanticCacheUsageError`, `EmbeddingError`, `ValkeyCommandError`
- Full TypeScript types exported from package root
- 23 tests: 13 unit tests (`utils.test.ts`) and 10 integration tests (`SemanticCache.integration.test.ts`); integration tests skip gracefully when Valkey is unreachable

### Valkey Search 1.2 compatibility notes

The following divergences from Redis/RediSearch were discovered during live verification and are handled in the implementation:

1. **`FT.INFO` error message** — Valkey Search 1.2 returns `"Index with name '...' not found in database 0"` rather than `"Unknown Index name"` (Redis/RediSearch convention) or `"no such index"`. The code matches all three patterns for cross-compatibility.
2. **`FT.DROPINDEX DD`** — The `DD` (Delete Documents) flag is not supported in Valkey Search 1.2. Key cleanup is done separately via `SCAN` + `DEL` after dropping the index.
3. **`FT.SEARCH` KNN score aliases** — KNN score aliases (`__score`) cannot be used in `RETURN` or `SORTBY` clauses. Results are returned automatically (without a `RETURN` clause) and pre-sorted by distance.
4. **`FT.INFO` dimension parsing** — The vector field dimension is nested inside an `"index"` sub-array (as `"dimensions"`) rather than exposed at the top-level `DIM` key used by RediSearch.
