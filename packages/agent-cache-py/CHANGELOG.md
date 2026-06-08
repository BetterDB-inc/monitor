## [0.7.0] - 2026-06-08

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
