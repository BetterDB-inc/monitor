# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
