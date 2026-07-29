# Changelog

All notable changes to `@betterdb/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-07-28

### Added

- **5 AI observability tools** for AI components running on the connected
  instance and traces ingested via OpenTelemetry (#330):
  - `ai_list_instances` — superset discovery view of all AI component
    instances (semantic caches, agent caches, agent-memory stores, retrieval
    pipelines) with liveness and the latest stored metrics sample.
  - `ai_instance_history` — stored metrics time-series for one AI component
    instance (hits, misses, hit rate, cost saved, evictions, item count, index
    size, threshold) for spotting hit-rate degradation, growth, or drift.
  - `list_ai_traces` — list recent AI application traces (LLM calls, cache
    lookups, memory recalls, retrieval spans).
  - `get_ai_trace` — full span waterfall for one trace with timing, parent
    relationships, and attributes (model, cache hit/miss, similarity scores).
  - `correlate_ai_trace` — join a trace's cache/memory spans with live Valkey
    state (key existence, TTL, active threshold, index state) to explain
    unexpected cache misses or stale memory recalls.
- **3 analytics tools** over the persisted metrics and anomaly stores (#331):
  - `get_forecast` — capacity forecast for a metric (`opsPerSec`,
    `usedMemory`, `cpuTotal`, `memFragmentation`) with projected time to
    ceiling.
  - `get_latency_regressions` — sustained p99 latency regressions vs baseline
    from the anomaly event store; companion to `get_anomalies`.
  - `get_largest_keys` — largest keys by measured memory usage from key
    analytics snapshots; companion to `get_hot_keys`. Requires BetterDB Pro
    (`keyAnalytics`).
- **2 vector-search tools** for the Search module (valkey-search / RediSearch)
  (#332):
  - `get_vector_indexes` — per-index health: document count, memory usage,
    indexing failures, and percent indexed.
  - `get_inference_latency` — FT.SEARCH p50/p95/p99 per vector index plus SLA
    breach status. SLA fields require BetterDB Pro inference SLA monitoring.

### Changed

- `get_health` / instance health now surfaces **config-hazard advisories**,
  including the default-user-enabled + AOF silent data-loss hazard
  (valkey#3983), with a distinct "could not verify" state (#337).
- README "Available Tools" updated with the new AI Observability, Analytics,
  and Vector Search sections.
- `server.json` registry version synced to `1.4.0` (it had drifted at `1.2.0`
  through the 1.3.x line).

### Pro tier

`get_largest_keys` requires BetterDB Pro (`keyAnalytics`) and the SLA fields of
`get_inference_latency` require Pro inference SLA monitoring. On community-tier
deployments the underlying endpoints degrade gracefully — `sla` is reported as
`null` and Pro-only endpoints surface the tier error to the agent.

## [1.3.2] - 2026-07-15

### Changed

- Part of the MIT licensing / re-release sweep across all public packages:
  added the `license` field to `package.json`, README badge row (version,
  downloads, MIT license, types), and a "See it live in BetterDB Monitor"
  section. Patch bump only — no tool changes.

## [1.3.1] - 2026-07-09

### Fixed

- Report the package version from package metadata instead of a hardcoded
  string (#222).
- Pass the `section` parameter through to the INFO endpoint so `get_info`
  section filtering works (#280).

## [1.3.0] - 2026-06-26

### Added

- **5 agent-memory read tools** for agent-memory stores discovered on an
  instance (#272):
  - `memory_stores` — list stores on an instance (name, capabilities, stats
    key).
  - `memory_list` — list memories in a store, newest first, with optional
    scope and tag filters.
  - `memory_get` — fetch a single memory by ID.
  - `memory_stats` — item count, eviction count, and live config for a store.
  - `memory_recall` — recall memories by a caller-supplied precomputed query
    vector.
- **4 agent-memory forget-proposal tools** (advisory — no deletions until
  approved) (#275):
  - `memory_forget` — propose forgetting memories by id or scope/tags; creates
    a pending proposal a human must approve.
  - `memory_list_pending_forgets` — list pending forget proposals on an
    instance.
  - `memory_approve_forget` — approve a pending proposal, applying the deletion
    against the live store.
  - `memory_reject_forget` — reject a pending proposal without deleting
    anything.

## [1.2.0] - 2026-05-04

### Added

- **5 cache-intelligence approval tools** wrapping the existing approval HTTP
  endpoints with `actor_source='mcp'` baked in:
  - `cache_list_pending_proposals` — list pending proposals on the active
    instance, optionally filtered by `cache_name`.
  - `cache_get_proposal` — fetch a single proposal by id including its audit
    trail.
  - `cache_approve_proposal` — synchronously approve and apply.
  - `cache_reject_proposal` — reject with optional reason.
  - `cache_edit_and_approve_proposal` — edit `new_threshold` or
    `new_ttl_seconds` and approve in one call. Invalidate proposals are not
    editable.
- README "Cache Intelligence Tools" section documenting all 14 cache tools
  (6 read-only + 3 propose + 5 approval) with two example prompts.

### Changed

- `server.json` registry version synced to `1.2.0`.

### Pro tier

The 14 cache-intelligence tools require BetterDB's Pro tier
(`Feature.CACHE_INTELLIGENCE`). On community-tier deployments the underlying
HTTP endpoints return 402 and the MCP tools surface that error to the agent;
no MCP-side gate is required.
