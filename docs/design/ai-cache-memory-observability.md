# AI Cache & Memory Observability — Design & Implementation Spec

> **Status:** in progress. This doc is the durable source of truth for the
> `feat/ai-cache-memory-observability` branch. It is written to survive context
> clears — the **Implementation status** checklist at the bottom is kept current
> so any session can resume. Update it as work lands.

## Goal

Give BetterDB Monitor a first-class view of what our AI libraries
(`@betterdb/agent-cache`, `semantic-cache`, `agent-memory`, `retrieval`, and
their Python twins) are doing at runtime. Two complementary data planes:

1. **Valkey-native (Phase 1)** — zero-config. Monitor already connects to the
   Valkey instance; the libs mirror their state into Valkey keys. We read the
   discovery registry + stats/config keys + FT index info. Works for *any* app
   on that instance with no code changes. Gives aggregate hit-rate, cost saved,
   evictions, similarity distribution, index health, current thresholds.
2. **OTel/OTLP ingestion (Phase 2)** — opt-in per instrumented app. Monitor
   accepts OTLP traces, keeps the `@betterdb/*` spans (+ their parent), stores
   them, and renders per-request waterfalls (`chat.turn` → `semantic_cache.check`
   → `agent_cache.llm.check` → `memory.recall` → LLM → `…store`). The
   **differentiator** is correlating a span (`cache.hit=false`, `cache.key`,
   `cache.model`) with the Valkey-side truth from Phase 1 (index state, threshold
   config, key TTL) to explain *why*.

The two are layered, not either/or: counters can't draw a waterfall; traces
can't tell you an index was degraded.

## What the libs expose (verified against source)

See the full inventory the four explorer passes produced. Key Valkey keys:

- **Discovery registry** `__betterdb:caches` (HASH): field = instance name
  (`{name}` or `{name}:mem`), value = JSON marker
  `{ type, prefix, version, protocol_version, capabilities, stats_key,
  index_name?, started_at, pid, hostname }`. `type` ∈ `agent_cache` /
  `semantic_cache` / `agent_memory` / `retrieval`.
- `__betterdb:protocol` (STRING, `"1"`), `__betterdb:heartbeat:{marker}` (STRING
  ISO ts, `EX 60`, refreshed 30s) → liveness.
- **agent-cache**: `{name}:__stats` (HASH counters: `llm:hits/misses`,
  `tool:hits/misses`, `tool:{t}:hits/misses/cost_saved_micros`,
  `session:reads/writes`, `cost_saved_micros`), `{name}:__tool_policies` (HASH).
  No FT index.
- **semantic-cache**: `{name}:__stats` (HASH: `total/hits/misses/cost_saved_micros`),
  `{name}:__similarity_window` (ZSET, rolling 7d/10k of
  `{score,result,category,cost_saved_micros}`), `{name}:__config` (HASH:
  `threshold`, `threshold:{category}`), FT index `{name}:idx`.
- **agent-memory**: `{name}:__mem_stats` (HASH: `evictions`), `{name}:__mem_config`
  (HASH: `recall.threshold`, `recall.weights.*`, `recall.halfLifeSeconds`,
  `maxItemsPerScope`), FT index `{name}:mem:idx`. Item count via `FT.INFO`.
- **retrieval**: docs at `{name}:{id}` (HASH), FT index `{name}:idx`. No stats
  hash; counts via `FT.INFO`.

**Latency is NOT in Valkey** — op/embedding/recall/judge durations live only in
OTel/Prometheus. Phase 1 therefore shows counts/rates/cost/similarity/index
health; latency arrives in Phase 2 (traces) or via an optional Prometheus scrape.

## Codebase patterns to reuse (verified)

- **Poller**: `apps/api/src/common/services/multi-connection-poller.ts` —
  abstract `MultiConnectionPoller`; implement `getIntervalMs()` +
  `pollConnection(ctx)`; `ctx.client: DatabasePort`, `ctx.connectionId`.
- **Command execution**: `DatabasePort.call(command, args, options?)`
  (`database-port.interface.ts:86`). Typed helpers exist too:
  `getVectorIndexList()`, `getVectorIndexInfo(name)`, `getCapabilities()`.
- **Closest analog = `apps/api/src/vector-search/vector-search.service.ts`**:
  extends the poller, reads FT indexes, builds snapshots,
  `storage.saveVectorIndexSnapshots(...)`, prunes on an interval. Mirror this
  structure almost verbatim.
- **Storage**: `StoragePort` in
  `apps/api/src/common/interfaces/storage-port.interface.ts`; time-series
  template = `StoredLatencyStatsSample` + `saveLatencyStatsSamples` /
  `getLatencyStatsHistory` / `pruneOldLatencyStatsSamples` (implemented in
  `storage/adapters/{sqlite,postgres,memory}.adapter.ts`). Also
  `VectorIndexSnapshot` (same shape, simpler).
- **Retention**: tier-based sweep (community 7d / Pro 90d / enterprise 365d).
  Find the existing license-tier retention helper used by monitor-capture /
  latency-stats and reuse it for `ai_cache_samples` (do NOT hardcode 7d like
  vector-search does).
- **Module registration**: add to `apps/api/src/app.module.ts` imports (see
  `VectorSearchModule` at line 173).
- **Web nav**: `apps/web/src/components/layout/AppSidebar.tsx` (`NavItem`,
  guarded by capability) + route in the router; page under `apps/web/src/pages/`.
- **Inbound ingest precedent (Phase 2)**: `posthog-proxy` (`@Controller('ingest')`)
  and `telemetry` (`@Post('event')`) controllers — same pattern for `/v1/traces`.

## Naming

Module: `ai-observability` (`apps/api/src/ai-observability/`). Web route:
`/ai-cache-memory`, tab label **"AI Cache & Memory"**. Shared types in
`@betterdb/shared` (mirroring how `VectorIndexSnapshot` lives there).

---

## Phase 0 — Shared foundation

`AiInstance` type + discovery-registry reader.

- `discovery-reader.service.ts`: `HGETALL __betterdb:caches` → parse each marker
  JSON → join `GET __betterdb:heartbeat:{field}` for `alive` + `lastHeartbeat`.
  Returns `AiInstance[]` (`{ marker, kind, prefix, capabilities, indexName?,
  statsKey, alive, lastSeen }`). Resilient to malformed markers (skip + log).
- Types in `@betterdb/shared`: `AiInstanceKind`, `AiInstanceMarker`, `AiInstance`.
- Tests against a fake `DatabasePort` (pattern: `mcp-memory.service.spec.ts`).

## Phase 1 — Valkey-native view

### Backend — `ai-observability` module
- `ai-observability.service.ts` extends `MultiConnectionPoller`:
  - `pollConnection`: discovery-read → per instance, by `kind`:
    - agent_cache: `HGETALL {name}:__stats` → diff vs last sample → hit-rate &
      cost-saved *rates*; per-tool breakdown.
    - semantic_cache: `HGETALL {name}:__stats` (+diff), `ZRANGE
      {name}:__similarity_window` (recent distribution), `HGETALL {name}:__config`.
    - agent_memory: `HGETALL {name}:__mem_stats`, `HGETALL {name}:__mem_config`,
      `FT.INFO {name}:mem:idx` (item count/dims).
    - retrieval: `FT.INFO {name}:idx` (doc count/dims).
  - Build `AiCacheSample[]`, `storage.saveAiCacheSamples(samples, connectionId)`.
  - Prune on interval via the tier-based retention helper.
  - Keep `lastStatsByInstance` Map for counter diffing; clean in
    `onConnectionRemoved`.
- Interval ~15s (config `AI_OBS_POLL_INTERVAL_MS`, default 15000).

### Storage — `ai_cache_samples`
`StoredAiCacheSample { id, connectionId, instanceName, kind, timestamp,
hits, misses, hitRate, costSavedMicros, evictions, items, indexBytes,
threshold?, extra? (JSON) }`. Add `saveAiCacheSamples` / `getAiCacheHistory`
(query opts) / `pruneOldAiCacheSamples` to `StoragePort` + all three adapters
(mirror `LatencyStatsSample`; sqlite/postgres get a `ROW_NUMBER()`-style
per-instance cap in history, memory adapter a per-instance cap — same fix as the
latency adapters). Wire prune into the retention sweep.

### API — `ai-observability.controller.ts`
- `GET /ai/instances` → discovered instances + liveness + latest summary.
- `GET /ai/instances/:name/summary` → current rollup.
- `GET /ai/instances/:name/history?hours=` → time series (charts).
- `GET /ai/instances/:name/similarity` → semantic-cache distribution.
- `GET /ai/instances/:name/index` → FT.INFO health.
- DTOs + controller tests.

### Web — "AI Cache & Memory" tab
- Sidebar `NavItem` + route + API client + `usePolling` hooks.
- Overview: instance cards (kind badge, liveness), KPI tiles (hit rate, $ saved,
  evictions, index size).
- Detail: hit-rate/cost/evictions time series, semantic similarity histogram,
  memory item count, index health, current config. Reuse chart components from
  Anomaly/VectorSearch pages.
- Optional: surface existing cache-proposals tuning actions inline.

## Phase 2 — OTLP ingestion + waterfall + correlation

- **Ingest**: `otel/otel-traces.controller.ts` `@Post('v1/traces')`, OTLP-HTTP
  (protobuf + JSON) via `@opentelemetry/otlp-transformer`. Token auth (reuse
  agent/webhook token model). Config `OTEL_INGEST_ENABLED`.
- **Filter**: keep spans whose instrumentation scope starts `@betterdb/` (+ the
  root/parent span for context). Drop the rest.
- **Storage**: `otel_spans` (+ trace index) across 3 adapters, with sampling/caps
  + TTL retention. ⚠️ highest-volume surface — cap and sample from day one.
- **Query API**: `GET /ai/traces` (recent `chat.turn` list), `GET
  /ai/traces/:traceId` (span tree).
- **Web**: trace list → waterfall (tree+timeline) → span attribute panel.
- **Correlation**: join span (`cache.hit`, `cache.key`, `cache.model`, ts) with
  Phase-1 Valkey state (index status, threshold, key TTL) to annotate misses.
- Docs: how to point an OTLP exporter at Monitor; scope filtering; env vars.

---

## Rough estimates
Phase 0 ~2–3d · Phase 1 ~2–3wk · Phase 2 ~4–6wk. Total ~7–9 dev-weeks solo.
First demoable increment at end of Phase 1.

## Decisions
- Retention: **tier-based** (7d/90d/365d) via existing helper — confirmed.
- Build ingestion in-house (not LangWatch-only) so any OTel lib interops.

---

## Implementation status  (keep current)

Legend: ☐ todo · ◐ in progress · ☑ done

- ☑ Branch `feat/ai-cache-memory-observability` from master
- ☑ **P0** design doc (this file)
- ☑ **P0** `@betterdb/shared` types: `AiInstanceKind`, `AiInstanceMarker`, `AiInstance`, `StoredAiCacheSample`, `AiCacheHistoryQueryOptions` (`packages/shared/src/types/ai-observability.ts`, exported from index)
- ☑ **P0** `ai-observability` module + `DiscoveryReaderService` + tests (5 passing) — `apps/api/src/ai-observability/`. Reuses `discovery-protocol` constants; generalizes the agent-memory-only reader in `mcp/memory` to all kinds + heartbeat liveness.
- ☐ **P1** `AiObservabilityService` poller (per-kind reads + counter diffing) — extend `MultiConnectionPoller`, model on `vector-search.service.ts`
- ☐ **P1** `ai_cache_samples`: StoragePort methods + sqlite + postgres + memory adapters + retention wiring
- ☐ **P1** controller + DTOs + tests; register `AiObservabilityModule` in `app.module.ts`
- ☐ **P1** web tab: nav + route + API client + overview + detail pages
- ☐ **P2** OTLP `/v1/traces` ingest controller + scope filter + token auth
- ☐ **P2** `otel_spans` storage across adapters + sampling/caps + retention
- ☐ **P2** traces query API + waterfall UI + Valkey-state correlation

### Session log
- 2026-07-10: doc created; patterns verified (poller, `DatabasePort.call`,
  vector-search analog, `StoredLatencyStatsSample`/`VectorIndexSnapshot`
  templates). P0 complete: shared types + `DiscoveryReaderService` + 5 passing
  tests, `@betterdb/shared` rebuilt, API typecheck clean. Run API unit tests with
  `SKIP_DOCKER_SETUP=true pnpm -F ./apps/api exec jest <path>`. Next: P1 poller +
  `ai_cache_samples` storage (mirror latency-stats adapters + tier retention).
