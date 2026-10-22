## [Unreleased]

### Added

- **Streaming response caching for the OpenAI Agents SDK adapter**
  (`betterdb_agent_cache.adapters.openai_agents`). `CachedModel.stream_response()`
  is now cache-aware: on a miss the upstream event stream passes through
  unchanged while the terminal `response.completed` is captured and persisted
  via `cache.llm.store_multipart()` after the stream drains; on a hit the
  stored response is replayed with the same event shape as a live stream
  (`response.created` … per-item/part deltas and `done` events …
  `response.completed`) and the underlying model is not called. A replayed
  response has `id=None` (like a non-streamed hit, so `previous_response_id`
  chaining is never pointed at a cache entry) and reports zero model requests
  in usage. Streamed requests share cache entries with
  their non-streamed twins (`get_response` key parity), so a stream can hit
  what a non-stream call stored, and vice-versa. Store failures are fail-open
  and never interrupt the delivered stream. This is the Python counterpart to
  the Vercel AI SDK `wrapStream` streaming cache added to `@betterdb/agent-cache`
  in v0.11.0.

### Behavior

- Only fully completed streams are stored: `response.incomplete` /
  `response.failed`, upstream errors, cancelled streams, and streams the
  consumer stops early are never cached.
- Streams whose output contains any tool or agent step (`function_call`,
  `file_search_call`, `web_search_call`, `computer_call`, `mcp_call`, …) are
  not stored — mirrors the `@betterdb/agent-cache` `wrapStream` convention of
  not caching half-executed agent steps. Non-streaming `get_response()`
  continues to cache tool calls (#149); a stream request can still *hit* such
  an entry and replays it intact.
- Store runs after the stream is fully delivered; failures log a warning and
  never surface to the caller.
- Responses with no text output (e.g. reasoning-only) are not stored.
- The upstream stream is closed as soon as the consumer stops (break,
  `aclose()`, cancellation), not left to garbage collection.
- If `response.completed` arrives with an empty `output`, the items streamed
  via `response.output_item.done` are stored instead.
- If a cache hit cannot be replayed, the adapter logs a warning and calls the
  model.

### Fixed

- `CachedModel` now subclasses the Agents SDK `Model` (when `openai-agents` is
  installed), so `Agent(model=CachedModel(...))` is accepted by current
  Agents SDK versions instead of raising `TypeError`. It also forwards
  `close()`, `_cleanup_on_run_end()` and `get_retry_advice()` to the wrapped
  model, so provider retry-after advice is preserved on both the streaming and
  non-streaming paths.
  `CachedModelProvider` was unaffected.

## [0.11.0] - 2026-07-10

### Added

- **Pydantic AI adapter** (`betterdb_agent_cache.adapters.pydantic_ai`).
  Exact-match LLM caching for [Pydantic AI](https://ai.pydantic.dev/).
  - `CachedModel(model, cache)` — wraps any Pydantic AI `Model`; intercepts
    `request()` for cache-before-call and delegates everything else via
    `__getattr__`. On a hit the response (text or tool calls) is reconstructed
    with stored token counts and the underlying model is not called.
  - `prepare_params()` normalizes Pydantic AI message history to
    `LlmCacheParams` across all part types; `ThinkingPart` is dropped as
    non-deterministic, and `ImageUrl` / `BinaryContent` are routed through the
    binary normalizer so blobs become compact refs instead of raw base64.
  - `model_request_parameters` (tool schemas) is excluded from the cache key —
    safe when one `CachedModel` wraps a single `Agent`.
  - New optional dependency extra: `pydantic_ai` (`pydantic-ai-slim>=2.0.0`).

## [0.10.0] - 2026-07-09

### Added

- **OpenAI Agents SDK adapter** (`betterdb_agent_cache.adapters.openai_agents`).
  Exact-match LLM caching for the [OpenAI Agents SDK](https://github.com/openai/openai-agents-python),
  intercepting at the `Model.get_response()` level so agent workloads that
  replay the same tool-call sequences (eval, testing, multi-agent orchestration)
  skip the API entirely. Distinct from the existing Chat Completions
  (`openai`) and Responses (`openai_responses`) adapters.
  - `CachedModel(model, cache)` — wraps any Agents SDK `Model`; cache-before-call
    on `get_response()`. `stream_response()` is delegated uncached (per the
    BetterDB streaming convention).
  - `CachedModelProvider(provider, cache)` — wraps any `ModelProvider` so every
    `Model` it yields is cache-enabled. Recommended integration via
    `RunConfig(model_provider=...)`.
  - `prepare_params()` normalizes Agents SDK `get_response()` inputs
    (system instructions + Responses API input items) to `LlmCacheParams`.
  - New optional dependency extra: `openai_agents` (`openai-agents>=0.1.0`).

## [0.7.0] - 2026-06-11

### Fixed

- **LlamaIndex adapter: tool definitions now included in cache key.** When `tools` is passed to `prepare_params()`, tool metadata (name, description, parameters) is extracted and included in the cache key. Only serializable metadata is used; callable closures are never serialized.

### Changed

- **Cache keys changed for tool-using requests on the LlamaIndex adapter.** Existing cached entries for those requests will be a one-time miss after upgrade. This is intended: the prior entries were keyed without tool information and are not safe to reuse across differing tool sets.
- **`prepare_params()` now accepts a `tools` keyword argument (and `LlamaIndexPrepareOptions.tools` field).** Callers must pass `tools` to get tool-schema safety. Omitting it falls back to messages-only keying (prior behavior).

### Known limitations

- **LangChain adapter: tool-schema drift is not reflected in the cache key.** The framework's `BaseCache` interface exposes only `(prompt, llm_string)` to the cache layer, so tool definitions are structurally unreachable. Unchanged in this release; documented as a known limitation.

## [0.6.0] - 2026-05-04

### Added

- **Periodic config refresh** — `AgentCache` polls `{name}:__tool_policies` on a configurable interval (default 30s) and atomically swaps the in-memory policy map. Externally-applied policy changes (e.g. from BetterDB Monitor's cache proposal feature) take effect without a process restart. Configure via the new `config_refresh` option (`enabled`, `interval_ms`); opt out with `config_refresh=ConfigRefreshOptions(enabled=False)`. New Prometheus counter `{prefix}_config_refresh_failed_total`.
- **`ToolCache.refresh_policies()`** — public method returning `bool` for consumers who want to drive the refresh manually.

### Changed

- **`ToolCache.load_policies()`** now performs an atomic swap (clears then repopulates) rather than an additive merge. Policies deleted externally (HDEL) are now evicted from in-memory state on the next refresh.

## [0.5.0] - 2026-05-04

### Added
- **Discovery marker protocol** — on construction, the cache registers itself in a Valkey-side `__betterdb:caches` hash and writes a periodic `__betterdb:heartbeat:{name}` key (default 30s). Lets BetterDB Monitor enumerate live caches. New `discovery` option. New Prometheus counter `{prefix}_discovery_write_failed_total`. `shutdown()` stops the heartbeat.
