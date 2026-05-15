# Changelog

## [0.4.0] - 2026-05-15

### Added

- **LLM-as-judge for borderline hits** — `CacheCheckOptions.judge` accepts a `JudgeOptions` with a `judge_fn` that adjudicates hits whose cosine distance lands in the uncertainty band (`threshold - uncertainty_band < score <= threshold`). Accepted hits are promoted to `confidence='high'`; rejected hits are demoted to a miss with `nearest_miss` populated. Configurable `timeout_ms` (default 2000) and `on_error` (default `'accept'`, fail-open).
- New Prometheus metrics `{prefix}_judge_decisions_total` (labels: `decision`) and `{prefix}_judge_duration_seconds` (labels: `decision`) with decision values `accept | reject | error_accept | error_reject | timeout_accept | timeout_reject`.
- `JudgeOptions` type exported from the package root.
- `examples/judge/main.py` — runnable example demonstrating accept, reject, and no-invocation paths.

### Changed

- `NearestMiss.delta_to_threshold` may now be `<= 0` when a miss originates from a judge rejection (score cleared the threshold but the judge rejected it). Existing miss paths still produce `> 0`. Documented on the type.
- `check_batch()` raises `SemanticCacheUsageError` when `judge` is supplied, matching the existing handling of `rerank` and `stale_after_model_change`.

### Breaking changes

None.

## [0.3.0] - 2026-05-05

### Added

- **Periodic config refresh** — `SemanticCache` polls `{prefix}:__config` every 30s and updates `default_threshold` / `category_thresholds` in-memory. First refresh fires synchronously on `initialize()` so a freshly-started process picks up an already-applied proposal immediately. Configure via the new `config_refresh` option; opt out with `config_refresh=ConfigRefreshOptions(enabled=False)`. New Prometheus counter `{prefix}_config_refresh_failed_total`.
- **`refresh_config()`** — public method returning `bool` for manual refresh.
- **`threshold_adjust` capability** — added to the discovery marker's `capabilities` array.
- **`ConfigRefreshOptions`** type exported from the package.

### Changed

- Constructor values for `default_threshold` and `category_thresholds` are now used as fallbacks when the corresponding fields are absent from `__config`.

### Behavior change

- A `{prefix}:__config` Valkey hash that previously had no effect now drives `default_threshold` and `category_thresholds` at runtime. Audit existing keys before upgrading, or set `config_refresh=ConfigRefreshOptions(enabled=False)` to keep constructor values authoritative.

## [0.2.0] - 2026-05-04

### Added
- **Discovery marker protocol** — on `initialize()` the cache registers itself in a Valkey-side `__betterdb:caches` hash and writes a periodic `__betterdb:heartbeat:{name}` key (default 30s). Lets BetterDB Monitor enumerate live caches. Marker payload includes `type=semantic_cache`, `capabilities` (`invalidate`, `similarity_distribution`, `threshold_adjust`), threshold config, and category thresholds. New `discovery` option. New Prometheus counter `{prefix}_discovery_write_failed_total`. `shutdown()` stops the heartbeat.

## 0.1.0 — 2026-04-24

Initial release. Full async Python port of `@betterdb/semantic-cache` v0.2.0,
feature-for-feature parity with the TypeScript implementation.

### Added

- **`SemanticCache`** — async class backed by Valkey vector search (`FT.SEARCH` KNN).
  Dataclass config (`SemanticCacheOptions`), `asyncio.Lock`-guarded `initialize()`.
- **`check(prompt)`** — similarity lookup returning `CacheCheckResult` with `hit`,
  `confidence` (`high` | `uncertain` | `miss`), `similarity`, `matched_key`,
  `nearest_miss`, `cost_saved`, and `content_blocks`.
- **`store(prompt, response, opts?)`** — stores prompt/response pairs with optional
  TTL, category tag, model tag, cost metadata, and sampling params.
- **`store_multipart(prompt, blocks, opts?)`** — stores a structured `ContentBlock`
  list as the cached response; returned as `result.content_blocks` on hit.
- **`check_batch(prompts, opts?)`** — embeds all prompts in parallel, pipelines all
  `FT.SEARCH` calls; returns results in input order.
- **`invalidate(filter)`** — batch delete by `FT.SEARCH` filter expression.
- **`invalidate_by_model(model)`** / **`invalidate_by_category(category)`** — helpers.
- **`stats()`** — hit/miss/total counts, hit rate, cumulative `cost_saved_micros`.
- **`index_info()`** — index name, doc count, vector dimension from `FT.INFO`.
- **`threshold_effectiveness(min_samples?)`** — analyzes rolling score window and
  returns `tighten_threshold`, `loosen_threshold`, `optimal`, or `insufficient_data`.
- **`threshold_effectiveness_all(min_samples?)`** — per-category + aggregate results
  from a single `ZRANGE` call.
- **`flush()`** — drops the FT index; cluster-aware `SCAN` + per-key pipelined `DEL`
  for entry and embedding keys.
- **`shutdown()`** — cancels the stats task and flushes the analytics queue.
- **Multi-modal prompts** — `check()`, `store()`, `store_multipart()` accept
  `str | list[ContentBlock]`. Binary refs stored as `binary_refs TAG` with AND
  semantics on lookup.
- **Binary normalizer** — `compose_normalizer`, `hash_base64`, `hash_bytes`,
  `hash_url`, `fetch_and_hash`, `default_normalizer` (hashes base64/bytes).
  Accessible via `cache.normalizer`.
- **Embedding cache** — Float32 vectors stored at `{name}:embed:{sha256}` with
  configurable TTL. Bypasses `embed_fn` on repeated lookups for the same text.
- **Cost tracking** — `CacheStoreOptions.input_tokens` / `output_tokens`. Bundled
  `DEFAULT_COST_TABLE` with 1,900+ models from LiteLLM, refreshed on every release.
- **Rerank hook** — `CacheCheckOptions.rerank` (`RerankOptions(k, rerank_fn)`).
  Retrieve top-k candidates; return the winning index or `-1` to reject all.
- **Stale-model eviction** — `CacheCheckOptions.stale_after_model_change` /
  `current_model`. Evicts the entry and returns a miss when the stored model differs.
- **Uncertainty band** — hits within `uncertainty_band` of the threshold return
  `confidence='uncertain'` instead of `'high'`.
- **Per-category thresholds** — `SemanticCacheOptions.category_thresholds`.
- **Params filtering** — `temperature`, `top_p`, `seed` stored as NUMERIC fields.
- **PostHog analytics** — baked API key injected at wheel build time via
  `hatch_build.py`. Opt out with `BETTERDB_TELEMETRY=false` or
  `AnalyticsOptions(disabled=True)`. Runtime override via
  `BETTERDB_POSTHOG_API_KEY` env var.
- **Adapters** — six provider adapters, all returning `SemanticParams(text, blocks, model)`:
  - `betterdb_semantic_cache.adapters.openai` — OpenAI Chat Completions
  - `betterdb_semantic_cache.adapters.openai_responses` — OpenAI Responses API
  - `betterdb_semantic_cache.adapters.anthropic` — Anthropic Messages
  - `betterdb_semantic_cache.adapters.llamaindex` — LlamaIndex `ChatMessage` list
  - `betterdb_semantic_cache.adapters.langchain` — LangChain `BaseCache` (async-only)
  - `betterdb_semantic_cache.adapters.langgraph` — `BetterDBSemanticStore`
- **Embedding helpers** — five `EmbedFn` factories:
  - `betterdb_semantic_cache.embed.openai` — OpenAI Embeddings API
  - `betterdb_semantic_cache.embed.voyage` — Voyage AI (httpx)
  - `betterdb_semantic_cache.embed.cohere` — Cohere Embed v3 (httpx)
  - `betterdb_semantic_cache.embed.ollama` — Ollama local models (httpx)
  - `betterdb_semantic_cache.embed.bedrock` — AWS Bedrock (boto3)
- **Observability** — 7 Prometheus metrics (`requests_total`, `similarity_score`,
  `operation_duration_seconds`, `embedding_duration_seconds`, `cost_saved_total`,
  `embedding_cache_total`, `stale_model_evictions_total`) + OpenTelemetry spans on
  every operation.
- **Cluster support** — `ValkeyCluster` client supported throughout. `cluster_scan`
  iterates all primary nodes for `flush()` and `invalidate_by_*`.
- **12 runnable examples** covering every adapter and major feature.
- **89 unit tests** (6 skipped when `langchain-core` not installed).
