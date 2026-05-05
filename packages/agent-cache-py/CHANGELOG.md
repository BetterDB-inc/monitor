## [0.6.0] - 2026-05-04

### Added

- **Periodic config refresh** — `AgentCache` polls `{name}:__tool_policies` on a configurable interval (default 30s) and atomically swaps the in-memory policy map. Externally-applied policy changes (e.g. from BetterDB Monitor's cache proposal feature) take effect without a process restart. Configure via the new `config_refresh` option (`enabled`, `interval_ms`); opt out with `config_refresh=ConfigRefreshOptions(enabled=False)`. New Prometheus counter `{prefix}_config_refresh_failed_total`.
- **`ToolCache.refresh_policies()`** — public method returning `bool` for consumers who want to drive the refresh manually.

### Changed

- **`ToolCache.load_policies()`** now performs an atomic swap (clears then repopulates) rather than an additive merge. Policies deleted externally (HDEL) are now evicted from in-memory state on the next refresh.

## [0.5.0] - 2026-05-04

### Added
- **Discovery marker protocol** — on construction, the cache registers itself in a Valkey-side `__betterdb:caches` hash and writes a periodic `__betterdb:heartbeat:{name}` key (default 30s). Lets BetterDB Monitor enumerate live caches. New `discovery` option. New Prometheus counter `{prefix}_discovery_write_failed_total`. `shutdown()` stops the heartbeat.
