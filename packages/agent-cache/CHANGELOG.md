# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
