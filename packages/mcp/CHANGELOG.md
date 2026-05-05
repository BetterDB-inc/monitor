# Changelog

All notable changes to `@betterdb/mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
