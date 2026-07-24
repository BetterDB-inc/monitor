# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`CachedChatModel` — tool-schema-aware LangChain caching.** A `BaseChatModel`
  wrapper (`@betterdb/agent-cache/langchain`) that caches at the model level
  instead of through LangChain's `BaseCache`, so bound tool schemas
  (`.bindTools(...)`), `tool_choice`, and the wrapped model's sampling params are
  all included in the cache key. Wrap any chat model:
  `new CachedChatModel({ model, cache })`. Tool schemas are normalized with
  LangChain's `convertToOpenAITool`, so Zod-based tools key on canonical JSON
  Schema rather than on Zod internals. Streaming is supported: on a miss the
  upstream chunks pass through untouched and the aggregate is stored on
  completion; on a hit the stored response replays as a single chunk. Tool-call
  responses are stored via `storeMultipart` and rebuilt on hit.

  Resolves the tool-schema-drift limitation documented under v0.7.0 for callers
  who opt into the wrapper; the existing `BetterDBLlmCache` (`cache=`) path is
  unchanged and retains the `(prompt, llm_string)` limitation by design.

### Behavior

- No cache keys change for existing `BetterDBLlmCache` users. `CachedChatModel`
  is a separate, opt-in integration.

## [0.11.1] - 2026-07-09

### Fixed

- **Build no longer ships compiled tests** — `tsconfig.json` `exclude` now
  matches nested test dirs (`src/**/__tests__` instead of only `src/__tests__`),
  so `src/adapters/__tests__` is kept out of the published `dist/`. No runtime
  or API changes.

## [0.11.0] - 2026-07-07

### Added

- **Streaming response caching for the Vercel AI SDK adapter** —
  `createAgentCacheMiddleware()` now implements `wrapStream` in addition to
  the existing `wrapGenerate`. On a cache miss, the upstream stream is tee'd:
  one branch flows back to the caller unchanged, the other accumulates
  `text-delta` chunks and stores via `cache.llm.store()` on stream finish.
  On a cache hit, `doStream` is skipped and the cached response is replayed
  as one `text-delta` chunk plus `finish` with
  `providerMetadata: { agentCache: { hit: true } }`. Closes the streaming
  limitation documented in v0.6.x.

### Behavior

- Tool-call streams are not cached — mirrors the existing `wrapGenerate`
  behavior to avoid caching half-executed agent steps.
- Store happens asynchronously after stream completion; store failures never
  affect the caller-facing stream.
- Upstream errors propagate unchanged. Partial responses are not cached.
- A `cache.llm.check()` failure falls through to upstream and is logged
  at debug level — telemetry never breaks the cache call.

### Breaking changes

None. Existing `wrapGenerate`-only consumers see no difference.

## [0.7.0] - 2026-06-11

### Fixed

- **Vercel AI SDK adapter: tool definitions now included in cache key.** Previously, the adapter only keyed on model, messages, temperature, topP, and maxTokens. Requests with identical messages but different tools could return the same cached response. `seed`, `stopSequences`, `responseFormat`, and `toolChoice` are now also part of the key.
- **LlamaIndex adapter: tool definitions now included in cache key.** When `tools` is passed to `prepareParams()`, tool metadata (name, description, parameters) is extracted and included in the cache key. Only serializable metadata is used; the `call` closure is never serialized.

### Changed

- **Cache keys changed for tool-using requests on Vercel and LlamaIndex adapters.** Existing cached entries for those requests will be a one-time miss after upgrade. This is intended: the prior entries were keyed without tool information and are not safe to reuse across differing tool sets.
- **LlamaIndex `prepareParams()` now accepts a `tools` option.** Callers must pass `tools` to get tool-schema safety. Omitting it falls back to messages-only keying (prior behavior).

### Known limitations

- **LangChain adapter: tool-schema drift is not reflected in the cache key.** The framework's `BaseCache` interface exposes only `(prompt, llm_string)` to the cache layer, so tool definitions are structurally unreachable. Unchanged in this release; documented as a known limitation.

## [0.6.0] - 2026-05-04

### Added

- **Periodic config refresh** — `AgentCache` now polls `{name}:__tool_policies`
  on a configurable interval (default 30s) and atomically swaps the in-memory
  policy map. Externally-applied policy changes (e.g. from BetterDB Monitor's
  cache proposal feature) take effect without a process restart. Configure via
  the new `configRefresh` option (`enabled`, `intervalMs`); opt out with
  `configRefresh: { enabled: false }`. New Prometheus counter
  `{prefix}_config_refresh_failed_total`.
- **`ToolCache.refreshPolicies()`** — public method returning `boolean` for
  consumers who want to drive the refresh manually.

### Changed

- **`ToolCache.loadPolicies()`** now removes policies that no longer exist in
  Valkey (atomic swap rather than additive merge). Previous behavior left
  stale local entries when a policy was HDEL'd externally.

## [0.5.0] - 2026-04-27

### Added

- **Discovery marker protocol** — on construction, the cache registers itself in a Valkey-side `__betterdb:caches` hash (one entry per cache `name`) and writes a periodic `__betterdb:heartbeat:<name>` key (default 30s). Lets BetterDB Monitor enumerate live caches without inspecting application config. Marker payload contains `type=agent_cache`, `version`, `prefix`, `protocol_version`, and a `capabilities` array. Caller can wait for registration to finish via `await cache.ensureDiscoveryReady()`. New `discovery` option to disable or override the heartbeat interval. New Prometheus counter `{prefix}_discovery_write_failed_total`. `shutdown()` stops the heartbeat and deletes the heartbeat key without touching cached entries.

## [0.4.0] - 2026-04-23

### Added

- **Bundled default cost table**
  - A default cost table sourced from [LiteLLM's `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) is now bundled with the package and refreshed on every release
  - Cost tracking works out of the box for 100+ models including GPT-4o, Claude, and Gemini — no `costTable` configuration required
  - User-supplied `costTable` entries are merged on top of the defaults, allowing selective overrides without losing coverage for other models

- **New `useDefaultCostTable` option on `AgentCacheOptions`**
  - Defaults to `true`. Set to `false` to disable the bundled table entirely and supply your own

- **`DEFAULT_COST_TABLE` export**
  - The bundled table is now exported from the main entry point for inspection or extension

- **`update:pricing` npm script**
  - Regenerates `defaultCostTable.ts` from the latest LiteLLM pricing data

## [0.3.0] - 2026-04-20

### Added

- **New provider adapters**
  - `@betterdb/agent-cache/openai` — OpenAI Chat Completions adapter; normalises `ChatCompletionCreateParams` including text, images (URL and base64), audio, files, tool calls, and legacy `function` role messages
  - `@betterdb/agent-cache/openai-responses` — OpenAI Responses API adapter; covers `reasoning` items, `function_call` / `function_call_output` item types, and `instructions` as a system message
  - `@betterdb/agent-cache/anthropic` — Anthropic Messages adapter; normalises tool use blocks, tool result blocks, thinking / extended thinking blocks, and image sources
  - `@betterdb/agent-cache/llamaindex` — LlamaIndex adapter; wraps `ChatMessage` history into the canonical format, covering text and image nodes

- **Pluggable binary normalizer**
  - New `BinaryNormalizer` interface controls how binary content (images, audio, documents) is reduced to a stable string before hashing
  - Built-in helpers exported from the main entry point: `hashBase64`, `hashBytes`, `hashUrl`, `fetchAndHash`, `passthrough`, `composeNormalizer`
  - `defaultNormalizer` uses `passthrough` behaviour — zero-latency, no network calls
  - `composeNormalizer(cfg)` factory accepts per-source-type and per-kind handlers for custom storage strategies

- **Extended `LlmCacheParams`**
  - `toolChoice`, `seed`, `stop`, `responseFormat` — now included in cache key computation
  - `reasoningEffort` — for models that support extended thinking
  - `promptCacheKey` — pass-through for provider-level prompt caching
  - New exported `LlmCacheMessage` type for consumers building params by hand

- **New content block types** exported from main entry point: `TextBlock`, `BinaryBlock`, `ToolCallBlock`, `ToolResultBlock`, `ReasoningBlock`, `BlockHints`

- **New examples**: `examples/openai`, `examples/anthropic`, `examples/llamaindex`

### Fixed

- `function_call_output` items with `null` or `undefined` output in the Responses adapter now produce an empty string instead of the two-character literal `""`
- Deduplicated `parseToolCallArgs` extracted to shared utility in `utils.ts`

## [0.2.0] - 2026-04-16

### Added

- Cluster mode support for all SCAN-based operations. When an iovalkey `Cluster` client is passed, `destroyThread()`, `invalidateByModel()`, `invalidateByTool()`, `flush()`, `getAll()`, `touch()`, and `scanFieldsByPrefix()` automatically iterate all master nodes. No API changes required.

### Changed

- Internal SCAN loops replaced with shared `clusterScan()` utility in `src/cluster.ts`
- `agent_cache.session.touch` span attribute renamed from `cache.touched_count` to `cache.touched_count_approx` — the value counts keys sent to EXPIRE, not keys that successfully refreshed (keys that expire between SCAN and EXPIRE are included in the count)

## [0.1.0] - 2026-04-14

### Added

- **Multi-tier caching architecture**
  - LLM response cache with exact-match on model, messages, temperature, top_p, max_tokens, and tools
  - Tool result cache with per-tool TTL policies
  - Session state store with sliding window TTL

- **LLM cache features**
  - `check()` for cache lookups by LLM parameters
  - `store()` for caching responses with optional token counts for cost tracking
  - `invalidateByModel()` for bulk invalidation by model name
  - Canonical JSON serialization with sorted keys for deterministic hashing
  - Tool array sorted by function name for order-independent matching

- **Tool cache features**
  - `check()` for cache lookups by tool name and arguments
  - `store()` for caching tool results with optional API cost tracking
  - `setPolicy()` for per-tool TTL configuration persisted to Valkey
  - `invalidateByTool()` for bulk invalidation by tool name
  - `invalidate()` for invalidating specific tool+args combinations
  - TTL precedence: per-call > per-tool policy > tier default > global default

- **Session store features**
  - `get()`/`set()` for individual field access with sliding window TTL
  - `getAll()` for retrieving all fields in a thread
  - `delete()` for removing individual fields
  - `destroyThread()` for complete thread cleanup including LangGraph checkpoints
  - `touch()` for refreshing TTL on all fields in a thread
  - Individual keys per field enabling per-field TTL (not Redis HASH)

- **Statistics and analytics**
  - `stats()` returning per-tier hit/miss counts, hit rates, and cost savings
  - `toolEffectiveness()` returning per-tool rankings with TTL recommendations
  - Counter-based stats stored in Valkey hash for cross-process aggregation

- **Framework adapters**
  - LangChain `BetterDBLlmCache` implementing `BaseCache` interface
  - Vercel AI SDK `createAgentCacheMiddleware()` implementing `LanguageModelMiddleware`
  - LangGraph `BetterDBSaver` implementing `BaseCheckpointSaver` (no modules required)

- **Observability**
  - OpenTelemetry tracing with spans for all cache operations
  - Prometheus metrics: `requests_total`, `operation_duration_seconds`, `cost_saved_total`, `stored_bytes_total`, `active_sessions`
  - Configurable tracer name and metrics prefix
  - Support for custom prom-client Registry

- **Error handling**
  - `AgentCacheError` base class for all errors
  - `AgentCacheUsageError` for caller mistakes
  - `ValkeyCommandError` for Valkey command failures with cause chaining

- **Utilities**
  - `sha256()` for consistent hashing
  - `canonicalJson()` for deterministic serialization with sorted keys
  - `llmCacheHash()` for LLM parameter hashing
  - `toolCacheHash()` for tool argument hashing
