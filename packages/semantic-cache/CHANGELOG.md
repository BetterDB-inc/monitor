# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-24

### Added

- **Cost tracking** - `store()` accepts `inputTokens`, `outputTokens`, and `model` to compute and persist `cost_micros` on the entry. `check()` returns `costSaved` (dollars) on hit and atomically increments `cost_saved_micros` in the stats hash. `stats()` returns `costSavedMicros`.
- **Bundled model price table** - `DEFAULT_COST_TABLE` with pricing for 1,971 models sourced from LiteLLM. Exported from the package root. `useDefaultCostTable` option controls merging. `update:pricing` npm script for refreshing.
- **Binary normalizer** - `normalizer.ts` ported from `agent-cache`: `hashBase64`, `hashBytes`, `hashUrl`, `fetchAndHash`, `passthrough`, `composeNormalizer`, `defaultNormalizer`. All exported from the package root.
- **ContentBlock types** - `TextBlock`, `BinaryBlock`, `ToolCallBlock`, `ToolResultBlock`, `ReasoningBlock`, `BlockHints` in `utils.ts`. All exported from the package root.
- **Multi-modal prompt support** - `check()` and `store()` accept `string | ContentBlock[]`. Text is extracted from `TextBlock` for embedding; binary refs from `BinaryBlock` are stored as a `binary_refs TAG` field and used as a pre-filter on lookup. Backward-compatible: string prompts produce byte-identical behavior.
- **`storeMultipart(prompt, blocks, options?)`** - stores structured `ContentBlock[]` as the cached response under `content_blocks` hash field. `check()` returns `contentBlocks` on hit when available.
- **OpenAI Chat Completions adapter** (`@betterdb/semantic-cache/openai`) - `prepareSemanticParams()` extracts last user message text and binary blocks from `ChatCompletionCreateParams`.
- **OpenAI Responses API adapter** (`@betterdb/semantic-cache/openai-responses`) - `prepareSemanticParams()` for the Responses API input format.
- **Anthropic Messages adapter** (`@betterdb/semantic-cache/anthropic`) - `prepareSemanticParams()` extracts last user message text and binary blocks from `MessageCreateParamsNonStreaming`.
- **LlamaIndex adapter** (`@betterdb/semantic-cache/llamaindex`) - `prepareSemanticParams()` extracts last user `ChatMessage` text and binary content.
- **LangGraph semantic memory store** (`@betterdb/semantic-cache/langgraph`) - `BetterDBSemanticStore` implementing a LangGraph-compatible `BaseStore` interface with `put()`, `get()`, `search()`, `delete()`, and `batch()`. Uses similarity-based retrieval. Distinct from `@betterdb/agent-cache/langgraph` which does exact-match checkpoint persistence.
- **Embedding helpers** - Five `EmbedFn` factory functions as subpath exports: `createOpenAIEmbed` (`/embed/openai`), `createBedrockEmbed` (`/embed/bedrock`), `createVoyageEmbed` (`/embed/voyage`), `createCohereEmbed` (`/embed/cohere`), `createOllamaEmbed` (`/embed/ollama`).
- **Embedding cache** - computed embedding vectors are stored in Valkey (`{name}:embed:{sha256}`) to avoid re-embedding the same text on repeated `check()` calls. Configurable via `embeddingCache.enabled` (default: `true`) and `embeddingCache.ttl` (default: 86400s). New Prometheus counter `{prefix}_embedding_cache_total`.
- **`checkBatch(prompts[], options?)`** - embeds all prompts in parallel and pipelines FT.SEARCH calls for efficient multi-prompt lookups. Results returned in input order.
- **`invalidateByModel(model)`** / **`invalidateByCategory(category)`** - thin wrappers around `invalidate()` for common use cases.
- **Threshold effectiveness recommendations** - `thresholdEffectiveness(options?)` analyzes a rolling sorted-set window (`{name}:__similarity_window`) of up to 10,000 scores over 7 days. Returns `recommendation` (`tighten_threshold`, `loosen_threshold`, `optimal`, `insufficient_data`), `recommendedThreshold`, and a human-readable `reasoning` string. `thresholdEffectivenessAll()` returns one result per category plus an aggregate.
- **Params-aware filtering** - `CacheStoreOptions.temperature`, `topP`, and `seed` stored as NUMERIC fields on entries. Filterable via `check()` filter option (e.g. `'@temperature:[0 0]'`).
- **`staleAfterModelChange`** - `CacheCheckOptions.staleAfterModelChange` and `currentModel`: on hit, if the stored model differs from `currentModel`, the entry is deleted and the result is treated as a miss. New Prometheus counter `{prefix}_stale_model_evictions_total`.
- **Rerank hook** - `CacheCheckOptions.rerank` with `k` and `rerankFn`. Retrieves top-k candidates and passes them to the function. Return -1 to reject all. Threshold is not applied to the reranked pick by default.
- **Cluster-aware `flush()`** - uses `clusterScan()` (ported from `agent-cache`) to iterate entry keys and embedding cache keys across all cluster master nodes.
- **FT.CREATE schema** - index schema now includes `binary_refs TAG`, `temperature NUMERIC`, `top_p NUMERIC`, `seed NUMERIC` alongside existing fields. Migration: `flush()` + `initialize()` rebuilds the schema.
- **13 runnable examples** in `examples/`: `openai`, `openai-responses`, `anthropic`, `llamaindex`, `langchain`, `vercel-ai-sdk`, `langgraph`, `multimodal`, `cost-tracking`, `threshold-tuning`, `embedding-cache`, `batch-check`, `rerank`.
- **`RELEASE_NOTES.md`** summarizing v0.2.0.
- **Test coverage**: 71 new unit tests across `cost.test.ts`, `multimodal.test.ts`, `features.test.ts`, `embedding-cache.test.ts`, and `adapters/` (4 adapter test files). Total: 99 tests.

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
- 27 tests: 9 unit tests (`utils.test.ts`), 8 adapter tests (`adapters.test.ts`), and 10 integration tests (`SemanticCache.integration.test.ts`); integration tests skip gracefully when Valkey is unreachable

### Valkey Search 1.2 compatibility notes

The following divergences from Redis/RediSearch were discovered during live verification and are handled in the implementation:

1. **`FT.INFO` error message** — Valkey Search 1.2 returns `"Index with name '...' not found in database 0"` rather than `"Unknown Index name"` (Redis/RediSearch convention) or `"no such index"`. The code matches all three patterns for cross-compatibility.
2. **`FT.DROPINDEX DD`** — The `DD` (Delete Documents) flag is not supported in Valkey Search 1.2. Key cleanup is done separately via `SCAN` + `DEL` after dropping the index.
3. **`FT.SEARCH` KNN score aliases** — KNN score aliases (`__score`) cannot be used in `RETURN` or `SORTBY` clauses. Results are returned automatically (without a `RETURN` clause) and pre-sorted by distance.
4. **`FT.INFO` dimension parsing** — The vector field dimension is nested inside an `"index"` sub-array (as `"dimensions"`) rather than exposed at the top-level `DIM` key used by RediSearch.
