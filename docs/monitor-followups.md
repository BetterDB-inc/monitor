# MONITOR — Post-Launch Follow-ups

Tracking list of cleanups and improvements identified during the per-PR review
pass on the MONITOR stack (PRs #163–#190). Items are grouped first by
**cross-cutting pattern** (issues that recurred across many PRs) and then by
**PR-specific findings** that don't fit a cross-cutting bucket.

None block launch. Mark items `- [x]` as they land.

---

## Cross-cutting cleanup

These patterns surfaced in multiple per-PR reviews. Each item below is the
canonical place to track the work; per-PR sections cross-reference these
rather than restating them.

### C1 — Discriminated unions for stored monitor types

Several stored shapes today use flat records with independent optionals,
permitting illegal states (e.g. `cancelled` trigger with a `firedSessionId`).
Convert each to a tagged union, then collapse the
`?.length ?? 0 > 0` / non-null-bang / unreachable-throw patterns at the call
sites.

Affected types (all in `packages/shared/src/types/monitor.ts` unless noted):

- `AclCheckResult` — add `'unknown'` arm with `probeError`; today three
  distinct failures (WHOAMI failed, GETUSER denied, connection dropped)
  collapse into `hasMonitor: false` plus a misleading remediation snippet
  (`apps/api/src/monitor/acl-checker.ts:4-13, 39, 47`). Also bump the
  swallowed-error log lines from `debug` to `warn`.
- `TerminationReason` — currently a free string accepting `'manual_stop'`,
  `'byte_cap'`, concatenated `'source_error: <msg>'`, and any user-supplied
  reason; replace with `{ kind: 'byte_cap'|'line_cap'|'duration_cap'|
  'manual_stop'|'source_ended' } | { kind: 'source_error'; message: string }`.
  Also truncate/redact `err.message` before storage (AUTH errors leak
  credentials) and `logError` on the source-error path. Sanitize before
  webhook dispatch in `monitor-capture.service.ts:286` so a future
  `failed`-tagged reason never leaks raw AUTH messages.
- `WebhookPayload.data` — drop `Record<string, any>`; add per-event payload
  types (`MonitorSessionStartedPayload | MonitorSessionCompletedPayload |
  MonitorSessionTruncatedPayload | …`) keyed on `event`; move dispatch into a
  `MonitorWebhookEventsService` mirroring `IWebhookEventsProService`. Derive
  `FREE_EVENTS` from `WEBHOOK_EVENT_TIERS` so the parallel structures cannot
  drift, and add a `schemaVersion` field before external consumers subscribe.
  Pin parity in `packages/shared/src/webhooks/types.spec.ts`.
- `NewShape` — `{ arity: number|null; scriptSha: string|null }` permits all
  four states; replace with `{ kind: 'plain'; arity } | { kind: 'scripted';
  cmd; scriptSha }`. Also hash EVAL script bodies before use
  (`sha1(body).slice(0, 16)`) — EVAL without preload uses `args[0]` as the
  *script source*, not a SHA, exploding cardinality and leaking script
  contents into responses (`cross-reference.engine.ts:21-27, 286-296`).
- `aclDeltas.counters` — today both counter fields are hard-coded `null`
  and the spec locks the placeholder in. Either drop the field until
  populated or surface `counters: { status: 'not-yet-implemented' }`. Also:
  `MonitorCaptureService.startSession`/`terminate` need INFO snapshots for
  the counter deltas to be implementable.
- `StoredCaptureSession` — `{ targetNode?, nodeSegments? }` permits both set
  and neither set with the fan-out flag. Convert to
  `Base & ({ kind: 'single'; targetNode? } | { kind: 'fanOut';
  nodeSegments: CaptureNodeSegment[] })`.
- `StoredCaptureTrigger` — flat shape lets a `cancelled` trigger appear to
  have a `firedSessionId`; tag by `status` so each variant only carries the
  fields it owns. Pairs with the atomic-claim follow-up (C9).
- `LastOutcome` (new shared type) — `lastFiredAt` / `lastFiredSessionId` /
  `lastSkipReason` on schedules and `firedAt` / `firedSessionId` /
  `skipReason` on triggers each encode three mutually-exclusive states as
  three independent optionals. Add
  `LastOutcome = { kind: 'fired'; at; sessionId } | { kind: 'skipped'; at;
  reason } | { kind: 'never' }` and unify naming.
- `ScheduleSpec` — replace independent `intervalSeconds?` /
  `cronExpression?` with
  `{ kind: 'interval'; intervalSeconds } | { kind: 'cron'; cronExpression;
  timezone? }`. Eliminates the `cronExpression!` non-null bang at
  `capture-scheduler.ts:175`, the dead-branch throw at `:153-157`, and
  turns the SQL CHECK into pure defense-in-depth. Forbid kind-flips with a
  stale partner field in `ScheduledCapturePatch`; remodel patch as
  `{ status?, durationMs?, schedule?: ScheduleSpec }`.
- `baseline.window` — `sessionId?` is always set when `window === 'capture'`
  and never otherwise. Convert to `{ window: 'capture'; sessionId: string } |
  { window: BaselineWindow }`. Eliminates the optional-chain in
  `compare-captures-panel.tsx:555`.
- `CaptureNodeSegment.status` — narrow from `CaptureSessionStatus` (5
  variants) to `CaptureWriterStatus`; `'skipped'`/`'running'` are nonsensical
  post-hoc.

### C2 — Postgres adapter coverage in `capture-sessions.spec.ts`

The `describe.each` runs only against Sqlite + Memory, so a growing list of
real partial-update SQL builders, JSONB columns, and ALTER migrations ship
with zero Postgres coverage:

- `saveCaptureChunk`, `updateCaptureSession`, `getCaptureChunks` (PR #167)
- `target_node` column + `$16` bind + `mapRow` (PR #177)
- `node_segments` JSONB column + partial patch (PR #178)
- `cron_expression` + XOR CHECK + legacy-schema migration (PR #185)
- The four new prune methods (PR #187)
- `redaction_mode` column (PR #189)

Either extend `describe.each` to bring up a docker-compose postgres (port
6383 is already used by anomaly tests) or add a dedicated integration spec
under `pnpm test:integration`. Tracked as one work item.

### C3 — Raw `process.env` → Zod schema migration

PR #165 introduced the pattern in `apps/api/src/config/env.schema.ts` but
subsequent PRs slipped back to raw `process.env` reads with local
`parsePositiveInt(raw, fallback)` helpers that silently fall back on
`'abc'`, `'-1'`, `'0'`, `'1.5'`. Migrate every remaining MONITOR env var to
Zod, inject via `ConfigService`, delete the local parsers:

- `MONITOR_DEFAULT_BYTE_CAP`, `MONITOR_DEFAULT_LINE_CAP`
  (`monitor-capture.service.ts:18-25`)
- `MONITOR_TRIGGER_POLL_MS` (`capture-trigger-registry.ts:576`,
  `DEFAULT_POLL_INTERVAL_MS`). Also log a WARN when `setInterval` fires
  while `ticking === true`, so silent throttling is visible.
- `MONITOR_PROVIDER_OVERRIDE` (`provider-detector.ts:80`). Same vector but
  security-adjacent; today `provider-detector.spec.ts:41-45` pins the
  silent fallthrough — update the spec to assert a thrown / `logError`
  instead. Gate to `NODE_ENV !== 'production'` and `logEvent(
  'preflight.provider_override_active', { provider })` at boot; surface
  `overrideActive: true` on `ProviderInfo`.
- `MONITOR_REDACT_VALUES` (`value-redactor.ts:97`). Strict `'true'` match
  silently disables redaction for `=1`, `=TRUE`, `=yes`, `=on`, `="true"`
  (Helm-quoted) — security toggle silently failing OFF. Use
  `z.enum(['true', 'false']).optional()` (or coerce); warn on any
  non-empty value that's not in the set. Update
  `value-redactor.spec.ts:217-224` accordingly.

### C4 — Move shared wire types to `packages/shared`

Several types are re-declared on both backend and frontend and have already
silently drifted in places. Move into `@betterdb/shared` and import from
both ends (or, where impractical, add a Zod parse at the `fetchApi`
boundary):

- Tail WS `OutboundMessage` / `ControlMessage`
  (`tail.gateway.ts:13-26, 114-116`, `useMonitorTail.ts:26-38`). Tighten
  `OutboundMessage.status` to `'session_ended' | 'historical_complete'`
  (currently `status: string` defeats the discriminated union); validate
  inbound `ControlMessage` with a Zod schema (currently
  `JSON.parse(...)` cast with zero runtime validation — a hostile client
  sending `{type: '__proto__'}` silently no-ops).
- `monitor-line.parser` (`apps/api/src/monitor/monitor-line.parser.ts` vs
  `filters-and-export.tsx:106-150`). Pure parser, no Nest deps. Minimum
  fallback: a parity test running identical line corpora through both
  implementations.
- `CrossReferenceResult` (`apps/web/src/api/monitor.ts:36-53`). Frontend
  declares `baseline.window: BaselineWindow` while backend
  `cross-reference.engine.ts:71` is `BaselineWindow | CaptureBaselineMarker`
  + optional `sessionId`. Drifted today.
- `CHUNK_INDEX_NAMESPACE` (`capture-writer.ts:139`,
  `monitor-capture.service.ts:57, 285`) — export from a shared module so
  writer + service can't drift.
- `DEFAULT_DURATION_MS` and `FIVE_MINUTES_MS` — currently in
  `preflight.service.ts:12`, `monitor-capture.service.ts:17`, and
  `start-session-modal.tsx:13`. Move to
  `packages/shared/src/monitor/defaults.ts` and import from all sites.

### C5 — Move monitor page components to `apps/web/src/components/pages/monitor/`

CLAUDE.md: "Pages components are in `components/pages` folder." Project
precedent at `components/pages/inference-latency/`, `cache-proposals/`,
`metric-forecasting/`. The MONITOR PRs continued a wrong prior precedent
in `apps/web/src/pages/monitor/`. Affected files:

- `sessions-table.tsx`, `session-status-badge.tsx` (PR #171)
- `start-session-modal.tsx` (PR #172)
- `cross-reference-panel.tsx` (and the new
  `cross-reference-panel/cross-reference-sections.tsx` split — see C12)
- `triggers-table.tsx` (PR #182)
- `create-schedule-modal.tsx` (PR #185)
- `compare-captures-panel.tsx` (PR #186)
- `preflight-panel.tsx` + split-out children (see PR #188)
- `capture-on-next-modal.tsx` — under
  `components/pages/anomaly-dashboard/`

### C6 — Typed `HttpError` + per-error UX in modals

`apps/web/src/api/client.ts:161` today throws an untyped `Error` with the
status code only embedded in the message string; `PaymentRequiredError`
(402) is the only typed exception. Introduce
`class HttpError extends Error { status: number; body?: unknown }` and
throw it from `fetchApi`. Then branch by status (route
`PaymentRequiredError` to the upgrade-prompt component; surface
server-JSON `message` for 4xx) in every modal that currently renders raw
`err.message`:

- `start-session-modal.tsx` (#172)
- `triggers-table.tsx` cancel flow + `Monitor.tsx:35-43` (#182)
- `capture-on-next-modal.tsx` (#183) — also map 409 dedup to "trigger
  already armed — view in Triggers" with a link to `/monitor?tab=triggers`
- `create-schedule-modal.tsx` (#185) — also reset state on submit (or
  `key={open ? 'open' : 'closed'}` to force remount), and `logError` with
  a stable errorId
- `compare-captures-panel.tsx` (#186)

### C7 — Surface query errors as banners

Several pages destructure only `{ data, loading }` from `useQuery` /
`usePolling`. On 4xx/5xx the empty state ("No capture sessions for this
connection yet.") is indistinguishable from a real empty result; 403
(license), 404 (no connection), 500 (DB down), network failure all
collapse identically. Destructure `error`, render an inline banner, call
`logError` with an errorId:

- `Monitor.tsx` sessions list (#171)
- `Monitor.tsx` triggers list (#182)
- `compare-captures-panel.tsx`: also wire `candidatesError` from the
  baseline-candidates query alongside the diff error (#186)
- `start-session-modal.tsx` `nodesQuery` errors render as a destructive
  banner ("Couldn't load cluster topology — capture may target an
  arbitrary node"); gate the dropdown's absence on the server's
  authoritative `isCluster` field rather than `clusterNodes.length > 0`
  (#177).

### C8 — Distinguish "empty result" from "axis unavailable"

A recurring silent-failure pattern: backend returns an empty array or
zeroed counters when a probe failed; UI renders "everything's clean,"
operator concludes a broken backend is healthy. Each site needs an
explicit `unavailable` / `unknown` state:

- `AclCheckResult` `'unknown'` arm (see C1).
- `cross-reference.engine.ts:669-691, 756-775` — `Promise.allSettled` per
  dimension + `dimensionUnavailable: 'slowlog' | 'audit' | …` on the
  result; UI gates on `'ok'`. Also add a bucket-based p95 with
  `MIN_BASELINE_SAMPLES` gating
  (`cross-reference.engine.ts:412, 446-454`) — `baselineRates` is one rate
  per distinct verb today (1–3 verbs typically), so p95 = that verb's
  rate, never regresses; empty baseline → p95 = 0 → every nonzero rate
  regresses. Bucket the baseline into N intervals (e.g. 60s), compute
  p95 of per-verb-per-bucket rates, and refuse to flag when
  `bucketCount < MIN_BASELINE_SAMPLES` (log
  `MONITOR_CROSSREF_INSUFFICIENT_BASELINE`).
- `cross-reference-panel.tsx:230-232, 251-253, 307-311` — once
  `dimensionUnavailable` lands, branch the empty-state copy. Until then,
  surface coverage caveats from `result.session.capturedLineCount === 0`
  and `baseline.rowCount === 0` distinctly.
- `/connections/:id/nodes` — bare `catch {}` maps every cluster-discovery
  failure (ACL-denied, network timeout, parser bug) to the same
  `{isCluster:false}` payload as a genuine single Valkey. Add a positive
  `isClusterConnection(id)` predicate; return `{isCluster:'unknown',
  reason}` on real failures (`monitor.controller.ts:371-375`).
- `resolveFanOutNodes` (`monitor-capture.service.ts:567-581`) — return a
  typed result `{ kind: 'not-cluster' } | { kind: 'discovery-failed';
  error } | { kind: 'nodes'; nodes }` and surface a 503 / typed error to
  the modal. Return 503 when `fanOut` was requested but zero primaries
  are healthy; surface `excludedNodes` when a subset is unhealthy.
- `compare-captures-panel.tsx` — slowlog/ACL sections of a
  capture-vs-capture diff need `evaluated: false` (the engine returns
  empty arrays today and the reused `CrossReferenceSections` UI renders
  "0 verbs above baseline p95"). Same for empty baseline: add
  `baseline.parsedLineCount` + `baseline.empty: true` to the result and
  render a warning.
- `ProviderBanner` `unknown` vs `self-hosted` — split branches; the
  `unknown` branch should hint "could not detect provider — check
  hostname or set `MONITOR_PROVIDER_OVERRIDE` (non-prod only)"
  (`preflight-panel.tsx:216-223`).

### C9 — Atomic, status-guarded state transitions + leader election

Across triggers and schedules, today's `update*` calls do blind status
patches and `findActive*` checks are not serialised across processes,
causing **multi-replica double-fire** and **illegal transitions
(e.g. `cancelled → fired`)** to land silently:

- `updateCaptureTrigger` (sqlite / postgres / memory): replace blind
  patches with `UPDATE … WHERE id = ? AND status IN (<expected>)`, add a
  `compareAndSetStatus(id, expected, next)` storage primitive, and add a
  partial unique index on
  `(connection_id, metric_type, anomaly_type) WHERE status IN
  ('configured','queued')`.
- `CaptureScheduler`: every replica registers per-row `setInterval` and
  fires each schedule N× per interval. Add a DB-level atomic claim
  (`UPDATE scheduled_captures SET last_fired_at = ? WHERE id = ? AND
  (last_fired_at IS NULL OR last_fired_at < ? - interval_seconds*1000)`)
  before `startSession`, or gate the scheduler to a single leader
  (advisory lock / role flag).
- `runRetention()` (`@Cron('0 3 * * *')`): every API replica fires the
  cron simultaneously → `15 × N` overlapping DELETE transactions at 03:00
  UTC. Wrap in `pg_try_advisory_lock(RETENTION_LOCK_ID)`, or insert into
  a `retention_runs(date UNIQUE)` row before running.

### C10 — Orphan / zombie session recovery

Multiple paths today leave session rows stuck `running` forever with no
recourse:

- `updateCaptureSession` failure during finalize (#167): row stays
  `running` even though the writer terminated. Add `finalizeError?:
  string` to `CaptureWriterResult`, retry once with backoff, emit
  `logError`, and add a janitor that re-finalizes stuck `running`
  sessions older than `2× durationMs`.
- Fan-out crashes (#178): writers use `skipSessionFinalize: true`; an API
  crash between `saveCaptureSession` and `finalizeFanOutSession` leaves
  the row `running` with all aggregation state in process memory. Add a
  startup reconciler that flips orphan `running` sessions older than `2×
  durationMs` to `failed` with
  `terminationReason='orchestrator_crash'`, or have writers persist
  per-node terminal segments so any survivor can finalize. Also: don't
  dispatch `sessionEnded` when `finalizeFanOutSession`'s storage write
  fails — retry with bounded backoff; on persistent failure log via
  `logError`, skip the dispatch, enqueue for the recovery sweep.
- Zombie-detection on every retention run (#187): SELECT-count
  `(active-status rows older than cutoff)` per table and
  `logError(RETENTION_ZOMBIE_DETECTED, ...)` when > 0. Preserve
  `status='failed'` sessions longer than the default cutoff
  (multiplier-based) — operators investigating an 8-day-old failed
  capture on community-tier (7d) install have no recourse today.

### C11 — Derive `requestedBy` / `createdBy` from auth, not the body

Today any caller can put any value in `requestedBy` /  `createdBy` and it
flows into the audit history / webhook payload unchanged. Strip from
every DTO; read from `@User()` decorator (or equivalent in the cloud-auth
integration). Affected endpoints:

- `POST /monitor/sessions` `requestedBy` (#168)
- `POST /monitor/triggers` `createdBy` (#181)
- `POST /monitor/schedules` (same shape if/when it accepts a creator
  field)

UI: bound `requestedBy` field with `maxLength={64}` until the server-side
strip lands.

### C12 — Logger.error → `logError` with stable errorId

The codebase uses both `Logger.error(message)` (stdout only, never lands
in Sentry, swallows non-Error rejections, drops the stack) and the
project-canonical `logError(errorId, err, context)`. Standardise on the
latter everywhere a failure could matter for ops triage:

- Webhook dispatch failures (`capture-trigger-registry.ts:331-333,
  353-355`) — define `MONITOR_TRIGGER_WEBHOOK_DISPATCH_FAILED` /
  `MONITOR_SESSION_SKIPPED_WEBHOOK_DISPATCH_FAILED` with
  `{ triggerId, connectionId, eventType, cause: err }`.
- Per-op retention catch (`data-retention.service.ts:67-72, 75`) —
  `RETENTION_PRUNE_FAILED`, include `{ op, cutoff, tier, err }`, and emit
  a structured `{ failures: string[] }` field in the summary log (today
  the `-1` sentinel for a failed prune is dropped by `.filter(v > 0)`).
- `lastSkipReason` errors persisted by the scheduler — store an opaque
  code (`start_failed`) plus a separate redacted detail; route full
  detail through `logError` (today `(err as Error).message` may include
  connection strings, IPs, internal hostnames and is exposed by
  `GET /monitor/schedules`).
- Typed `StorageNotInitializedError` for the 8 throw sites in the new
  prune methods (sqlite + postgres) — the retention catch eats opaque
  `new Error('Database not initialized')` and reports `-1` for every op.
- Frontend: every `logError` follow-up referenced from C6/C7/C8.

### C13 — Anchor `DemoModeGuard` prefix matching on path boundaries

`proprietary/cloud-auth/demo-mode.guard.ts:48` uses `apiPath.startsWith(p)`,
which falsely matches `/monitor/sessions-extra` / `…XYZ` /
`…-archive` against `/monitor/sessions`. Replace with `apiPath === p ||
apiPath.startsWith(p + '/')`. Fix once; applies to all entries in both
`DENIED_MUTATION_PREFIXES` and the allow-list. Add a regression test
asserting POST/DELETE → 403 + GET → 200 on demo host for
`/monitor/triggers` and `/monitor/sessions` — `demo-mode.guard.spec.ts`
has zero references to these paths today.

### C14 — Defensive frontend formatters + typed-record fallback

Multiple `Record<Enum, string>` lookups assume exhaustive backend types
and break the moment the backend adds a value:

- `SessionStatusBadge.STYLES[status]` — render fallback label + neutral
  styling (`session-status-badge.tsx:11-18`).
- `PROVIDER_LABELS[preflight.provider.provider]` —
  `preflight-panel.tsx:23`.
- `EVENT_LABELS[type] ?? type` — `WebhookForm.tsx:71-72`.
- `RESTRICTIONS[override] ?? []` + `logError('PREFLIGHT_PROVIDER_
  RESTRICTIONS_MISSING', { provider })` — `provider-detector.ts:91`.
- Triggers-table status badge: make it an exhaustive switch with a
  `never` check (compile-time); `logError` once per session on unknown
  status so version skew surfaces in Sentry (`triggers-table.tsx:107-121`).

Pure formatters also need numeric guards. Today `formatBytes(NaN)` falls
through every threshold and renders `"NaN GB"`;
`formatDuration(undefined)` returns `0ms`; `s.lineCount.toLocaleString()`
throws on undefined; `formatRelative(NaN)` renders `"NaN d"`;
`formatTimestamp(undefined)` renders `"Invalid Date"`. Guard with
`Number.isFinite`, render `—` for missing values, add Vitest specs
alongside `lib/formatters.test.ts` (precedent already present, contra the
PR #171 author's "no test infrastructure" claim). Also: delete the
duplicated `formatBytes` in `sessions-table.tsx:84-97`; move
`formatDuration` + `formatRelative` + `formatTimestamp` into
`apps/web/src/lib/format-time.ts`.

### C15 — One component per file (CLAUDE.md)

Multiple monitor page files export more than one component:

- `cross-reference-panel.tsx` exports `CrossReferencePanel` +
  `CrossReferenceSections`. Move to
  `components/pages/monitor/cross-reference-panel/cross-reference-sections.tsx`.
- `preflight-panel.tsx` defines `PreflightPanel`, `ProviderBanner`,
  `AclBanner`, `CopyableSnippet`, `Section`, `Badge`. Move under
  `components/pages/monitor/preflight-panel/` subfolder.

---

## PR-specific findings

Items below are unique to a single PR and don't fit a cross-cutting
bucket. Where a section is short or empty, it means the PR's issues were
absorbed by the cross-cutting items above.

### PR #165 — HealthGate deep module + diagnostic endpoint

- [ ] **Rename `GET /monitor/_diag/health-gate` → `GET
  /monitor/health-gate/check`.** The `_diag` prefix is a fabrication used
  only in this single route; the endpoint isn't a "diagnostic" — it
  evaluates the gate decision for a given connection. Update controller
  path, method name (consider `checkHealthGate`), spec doc, and
  `docs/monitor.md` REST surface section.

### PR #166 — ProviderDetector + AclChecker + pre-flight

- [ ] **Drop the `callPort` indirection**
  (`apps/api/src/monitor/acl-checker.ts:76-86`). The local
  `DatabasePortLike` interface duplicates `DatabasePort.call`; the
  `client: unknown` parameter discards a known type, and the
  `typeof c?.call !== 'function'` guard defends against an impossible
  scenario. Replace with `client.call('ACL', […])`; import `DatabasePort`
  for explicit typing. Net: −15 lines, no behaviour change.
- [ ] **Validate request bodies with class-validator DTOs.** Today
  `StartSessionRequestBody`, `PreflightRequestBody`, and
  `CreateTriggerRequestBody` are plain interfaces with all-optional
  fields; only `connectionId` is hand-checked. Negative / NaN / Infinity
  / over-cap values flow into the writer. Migrate to DTO classes with
  `@IsInt() @Min(1000) @Max(3_600_000) @IsOptional()` etc., and a
  `ValidationPipe`. Sites: `monitor.controller.ts:38-67` (start session),
  `:112` (preflight), all monitor endpoints accepting numeric body
  params.
- [ ] **`Promise.allSettled` in `PreflightService`**
  (`preflight.service.ts:64`). Currently `Promise.all([aclChecker.check,
  healthGateService.evaluate])` makes a transient INFO failure kill the
  entire preflight including successful provider/throughput sections.
  Switch to `allSettled` + per-section
  `{ status: 'ok', data } | { status: 'error', reason }`. Same pattern
  for the throughput section when `INFO stats` is redacted by a managed
  provider — return `{ available: false; reason }` instead of zeros.
- See also C1 (`AclCheckResult` union), C8 (provider unknown branch).

### PR #167 — CaptureWriter + chunk persistence

- [ ] **Surface chunk-persistence failures as a session-row signal**
  (`capture-writer.ts:174-178`). A rejected `saveCaptureChunk` is
  `.catch()`-swallowed with a `logger.error`; the session still finalizes
  as `completed`. Metadata reports "100 lines captured" while the chunk
  export contains 60. Add `chunkPersistFailures: number` to the writer,
  include it in the finalize patch
  (`terminationReason: completed_with_persistence_errors:N`, or a new
  `persistenceErrors` column), auto-escalate `status` to `'failed'` past
  a configurable threshold.
- [ ] **Expose dropped-line counters** (`capture-writer.ts`). Two
  distinct silent-drop paths: (a) ring-buffer FIFO eviction at 10000
  lines (line 187), (b) lines dropped after `stopped=true` between
  cap-detection and source-halt (line 230). Add `ringBufferDroppedCount`
  and `droppedAfterTermination` to `getCounters()` and surface in the
  session row / live-tail UI.
- See also C1 (`TerminationReason`), C2 (Postgres coverage),
  C10 (finalize zombie recovery).

### PR #168 — start/stop endpoints + Valkey MONITOR wiring

- [ ] **Fix TOCTOU race on active-session map in `startSession`**
  (`monitor-capture.service.ts:425-450`). Today: `if (active.has(c))
  throw 409 → await saveCaptureSession → await monitorSourceFactory →
  active.set(c, ...)`. Two parallel POSTs for the same `connectionId`
  both pass the `has()` check, both insert rows, both open MONITOR
  connections; the second `set` overwrites the first — leaks the first
  dedicated iovalkey socket. Reserve the slot synchronously
  (`active.set(c, placeholder)` immediately after the conflict check),
  clean up on every failure path. Add a `Promise.all([start(c),
  start(c)])` race test.
- [ ] **Close the MONITOR socket on writer construction / start failure**
  (`monitor-capture.service.ts:450-485`). If `saveCaptureSession`
  succeeds and the factory opens the dedicated socket but then
  `new CaptureWriter(...)` throws or `writer.start()` rejects, the socket
  is never `.disconnect()`-ed and the row sits `running` indefinitely.
  Wrap construction + `start()` in try/catch that calls
  `monitorSource.stop()` and patches the row to `'failed'` with
  `terminationReason: 'writer_init_failed: <msg>'`.
- [ ] **Detect iovalkey auto-reconnect during MONITOR mode**
  (`iovalkey-monitor-source.ts:284-303`). `client.monitor()` reconnects
  by default on socket drop, but the new socket is **not** in MONITOR
  mode (per-connection state). The wrapper keeps `stopped=false`, emits
  nothing, the writer never finalizes — silent zero-traffic capture.
  Either pass `{ retryStrategy: () => null }` so a drop becomes a hard
  `error`/`end`, or hook `monitor.on('reconnecting', ...)` and force-emit
  `'error'`.
- [ ] **Escape control characters and handle Buffer args in
  `formatMonitorLine`** (`iovalkey-monitor-source.ts:325-337`).
  `escapeArg` only escapes `\` and `"`. Real Valkey args can contain
  `\n`, `\r`, NUL, raw 0x80+ bytes; the wrapper writes them verbatim
  into persisted text, which breaks the `\n`-delimited storage
  assumption from PR #167, yields invalid UTF-8 in chunks, and
  `String(buf)` becomes `"[object Object]"` or lossy Latin-1. Match
  `valkey-cli`'s octal-escape (`\xNN`) for control chars; handle
  `Buffer` args explicitly. Export the formatter and add table-driven
  unit tests (none today).
- See also C11 (`requestedBy` from auth), C13 (DemoModeGuard anchoring).

### PR #169 — session lifecycle webhooks

- [ ] **Distinguish writer-error vs dispatch-error in the finalize
  chain** (`monitor-capture.service.ts:141-151`).
  `writer.start().then(dispatch).catch(log).finally(clear)` collapses
  both failure modes; a dispatch failure after the writer has finalized
  = row terminal, webhook never went out, no `webhook_deliveries` row,
  only trace is a single `logger.error`. Split so dispatch errors are
  caught separately, logged with their own errorId, and persisted via
  the existing webhook retry path (or a `dispatch_pending` marker).
- [ ] **Add a community-tier `monitor.session.failed` event** (or at
  minimum bump the writer-error log to `warn` with
  `sessionId`/`connectionId`). Community operators have zero signal
  today when a capture fails — the only trace is `this.logger.error` in
  api container logs. The Pro+ `monitor.session.skipped` event from
  PR #181 doesn't help community-tier.
- See also C1 (webhook payload union, sanitize `terminationReason`),
  C3 (Zod env vars).

### PR #170 — TailGateway WebSocket + pause/resume

- [ ] **Register `ws.on('error', ...)` and handle send failures**
  (`tail.gateway.ts`). The gateway listens only for `'close'`; every
  `ws.send` is fire-and-forget. A failed send emits `'error'` on the `ws`
  EventEmitter; with no listener the error is silently dropped, and the
  subscriber callback keeps firing into a broken socket — unbounded
  waste. Add `ws.on('error', ...)` at the top of `handleConnection`;
  unify close/error cleanup so subscribers can't leak when only `'error'`
  fires.
- [ ] **Apply backpressure on un-paused viewers via `ws.bufferedAmount`**
  (`tail.gateway.ts:128-141`). The 50000-line cap only protects
  *explicitly paused* viewers. A slow un-paused consumer makes Node's
  `ws` lib buffer in JS until the OS socket buffer fills, then keeps
  buffering — the API process heap grows without bound. When
  `bufferedAmount > THRESHOLD`, either pause-buffer with the same cap or
  `ws.close(1013, 'slow consumer')` and emit an operator-visible
  warning.
- [ ] **Signal pause-buffer overflow to the viewer**
  (`tail.gateway.ts:294-300`). At 50000 lines, `pausedBuffer.shift()`
  drops the oldest line with no signal. Track `droppedWhilePausedCount`,
  log WARN when it first crosses zero, and on resume send
  `{type:'status', status:'buffer_overflow', droppedLines: N}` before
  draining.
- [ ] **Add tenant / owner verification at the WS handshake**
  (`tail.gateway.ts:191-227`). Currently `sessionId` is the only
  capability — anyone with (or guessing) a sessionId gets the live tail,
  including for another tenant's database.
  `MonitorCaptureService.getSession` is called but the returned
  session's `requestedBy` / `connectionId` owner is never compared to
  the requestor. Pull the user from auth-proxy headers; reject when
  `session.requestedBy !== request.user`. Add a regression test.
- [ ] **Verify and fix `Host`-header semantics in `handleUpgrade`**
  (`tail.gateway.ts:60-64`). Two problems: (a) **forgeable** — a direct
  TCP client sets `Host: anything`. Trust `X-Forwarded-Host` from a
  known trusted ingress instead. (b) **likely inverted semantics** —
  current code *rejects* when `host === DEMO_HOSTNAME`, but
  `DemoModeGuard` for HTTP typically *restricts to* the demo host.
  Cross-check `DemoModeGuard` and align.
- [ ] **Propagate `CaptureWriterResult` through `onEnd`**
  (`capture-writer.ts:201`). Callback is `() => void` even though
  `CaptureWriterResult` exists. Gateway sends flat `'session_ended'`
  regardless of truncated/failed/clean completion. Promote to
  `(result: CaptureWriterResult) => void`; let the gateway send
  `{type:'error'}` for failed sessions and richer
  `{type:'status', status, terminationReason}` for the rest.
- [ ] **Fix the active-vs-historical subscribe-order race**
  (`tail.gateway.ts:122-141`). Between `getActiveWriter()` (line 73)
  and `writer.subscribe(...)` (line 122), the writer can terminate.
  `subscribe()` becomes a no-op; `onEnd` fires on a microtask *after*
  the backlog is sent, so the viewer receives backlog + `session_ended`
  instead of falling through to historical replay. Reorder: register
  `onEnd` first, drain backlog, then `subscribe`. Add a regression
  test that forces the race.
- See also C4 (wire types to shared).

### PR #171 — Sessions list with 5s polling

- [ ] **Clarify that counters are flushed-not-live in the Sessions
  table**. 5s polling pulls `byteCount`/`lineCount` from the session
  row, but the writer persists these only on chunk flush. A running
  session can show identical numbers for many polls then jump —
  operators reasonably read the cadence as "live" and file bug reports
  about "stuck" captures. Either rename the column header to
  "Lines (flushed)" / "Bytes (flushed)", or add a tooltip / footer
  indicator showing flush cadence + "updated Xs ago" on running rows.
- [ ] **Status-badge colors via theme variables, not hard-coded Tailwind
  classes** (`session-status-badge.tsx:4-9`). Today the badges use
  `bg-emerald-500/15 text-emerald-700 dark:text-emerald-300` etc. —
  exactly the "inline color breaks dark-mode" pattern CLAUDE.md guards
  against for charts. Map: `running → --chart-info`, `truncated →
  --chart-warning`, `failed → --chart-critical`, `completed → --primary`
  or `--chart-1`, `skipped → --muted`.
- See also C5 (component placement), C6 (`HttpError`), C7 (surface
  query errors), C14 (defensive formatters + `STYLES` fallback).

### PR #172 — start-session modal + pre-flight + 5-min confirmation

- [ ] **5-min confirmation guard can be bypassed by editing duration**
  (`start-session-modal.tsx:73-94`). First click on a 6-minute session
  sets `confirming=true`; user edits duration up to 999 minutes; second
  click fires without re-confirmation. Invalidate `confirming` whenever
  `durationMs` changes after entering confirm mode (extend the existing
  auto-clear-below-5m effect at `:43-45`).
- [ ] **Pre-flight failure must block start**
  (`start-session-modal.tsx:189-194`). Submit is gated only on
  `submitting || preflightLoading`, not on `!!preflightError`. If
  pre-flight fetch fails (network / license / 5xx) the user can blindly
  start a session the backend will reject. Gate Submit on
  `preflightError === null` (or require an explicit "Start without
  pre-flight" affordance with its own confirmation).
- [ ] **State-machine tests for the 5-min guard and state-reset-on-close**.
  Author shipped a state-carryover bug once already
  ("Bug caught and fixed during live testing"). Zero regression
  protection. Minimum matrix: 30s submit → API called immediately; 6m
  first submit → no API call, `confirming=true`; 6m second submit → API
  called; 6m → 30s → `confirming` clears; API rejects → `confirming`
  resets in `finally`, modal stays open; close at 6m → reopen → input
  shows 30s default (the carryover bug); rapid duration edits → only
  latest preflight result renders (race).
- [ ] **Use `AbortController` for pre-flight fetches + debounce duration
  input** (`start-session-modal.tsx:60-78`). Cancelled-flag prevents
  stale `setState` but the underlying `fetch` runs to completion on every
  keystroke. With unit=`s` and rapid typing, three pre-flight POSTs hit
  the backend. Wire `AbortController` per effect (pass `signal` through
  `fetchApi`); debounce duration changes by 250–300ms.
- [ ] **Duration input client-side validation** — `step={1}`,
  `Math.floor`, sane upper bound (session-cap-aware). Backend rejects
  `1.5`/`1e9` with generic 400 that collapses into opaque error string
  (see C6).
- See also C1 (`AclCheckResult` defensive rendering), C4
  (`FIVE_MINUTES_MS` to shared), C6 (per-error UX), C11 (`requestedBy`
  maxLength).

### PR #173 — live tail view + pause/resume + bounded buffer

- [ ] **Cancel pending `requestAnimationFrame` on unmount**
  (`useMonitorTail.ts:132-141, 199-209`). Cleanup never calls
  `cancelAnimationFrame`; queued callbacks fire after unmount and
  setState on a dead component. Store handle in a ref, cancel in the
  effect cleanup.
- [ ] **Surface `ws.onclose` code/reason and add reconnect**
  (`useMonitorTail.ts:164-174`). All non-1000 closures map to `closed`
  with the generic `"WebSocket connection error"` text.
  Handshake-rejected (1006/4xxx), server crash, graceful end all look
  identical with no retry path. Branch on `close.code`; render
  actionable text; add backoff reconnect for transient closes.
- [ ] **`historical_complete` / `session_ended` must close the WS**
  (`useMonitorTail.ts:140-142`). Code only updates state; doc claims the
  socket closes. Additional frames after a terminal status are still
  processed. Call `ws.close()` (handlers detached) on either status.
- [ ] **Derive WS URL from `window.location` / Vite proxy, not hardcoded
  `localhost:3001`** (`useMonitorTail.ts:96-99`). Today's dev URL breaks
  Codespaces, LAN-accessed dev, remote hosts, IPv6-only. Use Vite's dev
  proxy and hit `/api/monitor/ws` in both prod and dev, or derive from
  `window.location.hostname`.
- [ ] **`useMonitorTail` hook tests** — the most complex client-side
  stateful logic in the stack has zero coverage; `MockWebSocket` infra
  already in use (`useLicense.test.ts`). Minimum: open → `streaming`;
  line frames flush once per rAF; 5001 lines → `bufferTrimmed=true` +
  last 5000 retained + `totalReceived=5001`; pause/resume gate on
  `readyState === OPEN`; sessionId swap tears down old socket; unmount
  cancels rAF; StrictMode double-mount leaves one live WS.
- [ ] **Stable key on line list, not index** (`tail-view.tsx:469`). When
  the buffer trims oldest, every row's index shifts → full re-render,
  text selection breaks mid-stream. Use a monotonic id minted at push.
- [ ] **Validate inbound WS frames; log on unknown `type` / parse
  failure** (`useMonitorTail.ts:178-181`). Today `try { JSON.parse }
  catch { return }` silently drops malformed frames; unknown `msg.type`
  has no `else` branch. Use a Zod schema (or narrow guards) and
  `logError` on rejection. Pairs with C4 (shared wire types).

### PR #174 — post-capture filters + JSON/CSV export

- [ ] **CSV formula-injection mitigation**
  (`monitor-line.parser.ts:108-122`). A captured Valkey arg like
  `=cmd|'/c calc'!A1` opens in Excel/Sheets and executes — operators
  downloading forensic CSVs are the target. In `csvField`, prefix `=`,
  `+`, `-`, `@`, `\t`, `\r` with `'` and add `\r` to the special-char
  quote check.
- [ ] **Surface dropped-line count from the export endpoint**
  (`monitor.controller.ts:166-180`). Unparseable lines are silently
  `continue`-d. `{count: 4823, lines: [...]}` claims success when 17
  lines were dropped — bad for forensic. Track `droppedCount`, attach to
  JSON response, set `X-Monitor-Export-Parse-Errors` header, `logError`
  past a ratio threshold.
- [ ] **Validate `afterTs` / `beforeTs` (and reject unknown `format`)**
  (`monitor.controller.ts:147-150`). Today `parseInt('abc', 10)` → `NaN`
  silently becomes allow-all; `?afterTs=0` is falsy → silently dropped;
  `?format=xls` silently returns JSON. The test at
  `monitor.controller.spec.ts:282-288` codifies the format fallback —
  tripwire against fixing this. Reuse `parsePositiveInt` (which throws
  `BadRequestException` correctly); throw on unknown format; update the
  spec.
- [ ] **Stream the export instead of accumulating in memory**
  (`monitor.controller.ts:160-198`). Today the controller builds the
  full response as a string/array before `reply.send`. A 50 MB cap peaks
  at ~150-200 MB heap; 500 MB sessions OOM. Switch CSV to
  `reply.raw.write()` chunk-by-chunk and JSON to NDJSON (or streamed
  array). Wrap in try/catch so a mid-iteration storage rejection
  translates to a proper 5xx instead of a half-written 200.
- [ ] **Honest copy on the buffer preview + optional server-side count
  endpoint** (`filters-and-export.tsx:60-66`). The 5000-line live buffer
  is a tiny window of a session that may have millions of lines.
  "Buffer match: 50" → user clicks Export → 50000-line file; or buffer
  has zero matches because filter targets earlier-evicted traffic →
  operator abandons the export. Either re-word ("recent buffer only —
  may differ from server-side count") or add `?countOnly=true`.
- [ ] **Sanitize id in `Content-Disposition`**
  (`monitor.controller.ts:154-156`). `id` is interpolated directly into
  the header. UUIDs are safe today; a future broader id scheme makes
  CRLF/quote injection possible.
  `id.replace(/[^A-Za-z0-9_-]/g, '_')` before interpolation; add
  `filename*=UTF-8''…` for non-ASCII.
- See also C4 (parser to shared).

### PR #175 — CrossReferenceEngine + REST endpoint

- [ ] **DST-correct `same-hour-last-week`**
  (`cross-reference.engine.ts:277-281`). Today `sessionStartMs - WEEK_MS`
  shifts wall-clock 168h, not 7 calendar days. Spring forward / fall
  back drifts the window an hour for non-UTC deployments. Either
  calendar-shift via local date components or rename the window to
  reflect the 168h semantics and document.
- [ ] **Reject cross-reference on non-completed sessions** (controller +
  `cross-reference.engine.ts:109`). `session.endedAt ?? Date.now()`
  lets a `running` session compute against a sliding endpoint — two
  calls return different `newShapes`. Either 409 when `session.status
  !== 'completed'`, or accept `?allowPartial=true` and stamp
  `session.partial: true` on the response. (PR #186 needs the same fix
  for the baseline session.)
- [ ] **Look up `newInTopK` against the full key map, not the top-50
  slice** (`cross-reference.engine.ts:14, 357-362`). A key at baseline
  rank 60 → capture rank 5 currently appears in `newInTopK` (misleading
  — it WAS in baseline). A key going 49 → 51 silently vanishes from
  `rankChanges`. Look up in the full `baselineKeyCounts`; surface
  `rankInBaseline: '>50'` (or numeric rank + `wasBelowTopK: true`). Add
  a deterministic tiebreaker to the top-K sort
  (`(a,b) => b[1]-a[1] || a[0].localeCompare(b[0])`) — V8 stable-sort +
  differing insertion order across capture/baseline produces phantom
  `rankChange` rows today.
- See also C1 (`NewShape` union + EVAL hash, `aclDeltas.counters`),
  C8 (`Promise.allSettled` + dimensionUnavailable, bucket-based p95).

### PR #176 — cross-reference panel + baseline selector

- [ ] **Don't cache cross-reference results for `running` sessions**
  (`cross-reference-panel.tsx:128-132`). QueryKey is `['monitor',
  'cross-reference', sessionId, baseline]` — no status. A user opens a
  still-running session, the panel computes against in-progress capture
  and caches forever; status flips `running → completed` via parent
  polling but cross-reference never refetches. Either disable the query
  while `running`, include `status` in the queryKey, or invalidate from
  the parent on transition.
- [ ] **Truncate EVAL script bodies in `NewShapesList`**
  (`cross-reference-panel.tsx:235-247`). Per C1's `NewShape` follow-up,
  `EVAL` without preload encodes raw Lua source as the shape string. The
  component renders it in a `<span>` with no `truncate` / `break-all` /
  `max-width` — blows out the column. Wrap with `truncate` +
  `title={s.shape}`; special-case `cmd === 'EVAL' && scriptSha === null`
  to render `EVAL (inline script)` instead of the body.
- [ ] **Filter or dim `(redacted)` rows in the hot-key list**
  (`cross-reference-panel.tsx:262-269`). `(redacted)` is a MONITOR
  marker, not a key — rendering "(redacted) ×3 (rank #2)" as a top
  hot-key is misleading. Either filter into a "+N redacted entries"
  footnote, or render the row with `text-muted-foreground` + tooltip.
- [ ] **Disambiguate `aclDeltas.counters` `null` from `0` visually**
  (`cross-reference-panel.tsx:333-337`). Both render in the same
  `font-mono` style and color. The disambiguation footer at `:339-343`
  only appears when BOTH counters are null — a mixed state (one `null`,
  one `5`) shows `—` next to a real number with no explanation.
  Mute/italicize the `—` glyph and attach a per-row tooltip explaining
  "pending session-boundary snapshot."
- See also C4 (`CrossReferenceResult` to shared), C5 (component
  placement), C8 (empty vs unavailable branching).

### PR #177 — cluster per-node selector

- [ ] **Don't persist `targetNodeId` as `target_node` when address
  resolution fails** (`monitor-capture.service.ts:286-305`). The catch
  returns the raw cluster-discovery id (40-char hex) which is then
  written to `capture_sessions.target_node` — a column documented as
  "host:port string". No marker that the value is degraded. Either
  fail-fast (throw a typed error, roll back the session row) or skip
  persisting `targetNode` until resolution succeeds.
- [ ] **Backfill / disambiguate historical `target_node = NULL` rows**.
  Pre-PR cluster captures ran MONITOR on whatever node iovalkey routed
  to. After migration all of those rows have `target_node IS NULL` —
  indistinguishable from "single-instance capture." Add a
  `target_node_status` enum (`pre-cluster-aware | single-instance |
  targeted | fanout`); backfill pre-migration rows on cluster
  connections to `pre-cluster-aware`; surface in UI.
- [ ] **Validate `targetNodeId` on POST and surface "node removed"
  specifically** (`monitor.controller.ts:108-124`,
  `monitor-capture.service.ts:292-305`). Any string is accepted; stale
  modal (node removed between open and submit) records
  `target_node = 'lost-node'` and the generic "Failed to open MONITOR"
  fires later. Reject unknown ids with `BadRequestException`; map
  `NodeNotFoundError` to a `409` with `{code: 'target-node-not-found',
  nodeId, availableNodes}` so the modal can refresh.
- [ ] **Default-master selection in the modal must prefer healthy nodes**
  (`start-session-modal.tsx:636`). Today's `find(n => n.role ===
  'master') ?? clusterNodes[0]` pre-selects the first master regardless
  of `healthy`. During failover the unhealthy master is auto-selected
  and the user clicks Start before noticing `(unhealthy)`. Use
  `find(n => n.role === 'master' && n.healthy) ?? find(n => n.healthy)
  ?? [0]`; render a banner if zero masters are healthy.
- [ ] **Safer schema migrations on multi-replica Postgres**
  (`postgres.adapter.ts:1638-1647`). Concurrent `ADD COLUMN IF NOT
  EXISTS` from two booting replicas can race; the loser crash-loops on
  `42701`. Wrap the ALTER block in a try/catch that swallows `42701`
  specifically (or take an advisory lock); replace the bare-catch in
  the sqlite migration helper (`sqlite.adapter.ts:459-467`) with a
  code-specific guard.
- See also C2 (Postgres coverage), C7 (nodesQuery error banner),
  C8 (single-instance vs discovery-failed).

### PR #178 — cluster fan-out + partial failure

- [ ] **Enforce the 10M chunk-index namespace in `CaptureWriter`**
  (`capture-writer.ts:139`, `monitor-capture.service.ts:57, 285`). The
  per-writer range `[i*10M, (i+1)*10M)` is documented but never asserted.
  A writer that overruns silently corrupts per-node attribution. Either
  `terminate('truncated', 'chunk_namespace_exhausted')` when
  `chunkIndex >= startChunkIndex + CHUNK_INDEX_NAMESPACE`, or replace the
  namespace trick with an explicit `node_id` column on the PK (the
  column already exists from this PR). See C4 for the
  `CHUNK_INDEX_NAMESPACE` shared-export.
- [ ] **`aggregateSegmentStatus([])` should return `'failed'`, not
  `'completed'`** (`monitor-capture.service.ts:589`). For a fan-out
  session, empty segments means zero writers opened — a bug, not a
  success. Either narrow input to `NonEmptyArray<>` or return
  `{ status: 'failed', reason: 'no_nodes_resolved' }`. Today path is
  gated by `isFanOut = fanOutNodes.length > 0` but the function's
  invariant is wrong on its face.
- [ ] **Validate `nodeSegments` JSON on adapter read with Zod**
  (`sqlite.adapter.ts:893-902`, `postgres.adapter.ts:752-763`). Today
  both adapters do `try { JSON.parse } catch { return undefined }` with
  zero logging and only `Array.isArray` validation. A bad row (older
  schema, partial write, manual SQL) flows through as
  `CaptureNodeSegment[]` and crashes `.lineCount.toLocaleString()` in
  the UI. Add a shared Zod schema in `packages/shared`; parse on read;
  log invalid rows via `logError`.
- [ ] **Surface all fan-out writers (or label the visible one) from
  `getActiveWriter`** (`monitor-capture.service.ts:451-454`). Today
  returns `writers[0]` only — the tail UI silently shows one node's
  lines. Either return `getActiveWriters()` and let the tail interleave
  / paginate by node, or set `X-Monitor-Tail-Node: <nodeId>` so the UI
  can render "Showing node A of A, B, C."
- [ ] **Deadline + timeout on `stopSession` for fan-out**
  (`monitor-capture.service.ts:438-447`). `await active.donePromise`
  resolves only when every writer's `Promise.all` settles — one writer
  with a hung connection blocks `stopSession` forever and the HTTP
  request times out. Race against a 30s deadline; on timeout, mark
  unresolved segments `failed` with reason `stop_timeout` and finalize.
- See also C1 (`StoredCaptureSession` union, `CaptureNodeSegment.status`
  narrowing), C2 (Postgres coverage), C8 (`resolveFanOutNodes` typed
  result), C10 (orphan recovery, don't dispatch on finalize fail).

### PR #179 — Pro+ capture triggers + REST + license gate

- [ ] **Per-step + per-trigger try/catch in `tick()`**
  (`capture-trigger-registry.ts:712-724, 798`). `sweepExpired`,
  `processQueued`, `processNewAnomalies` run sequentially with no
  per-phase catch; one rejected storage call or `HealthGateService.evaluate`
  throw aborts the entire tick. Wrap each phase and each per-trigger
  iteration; on health-gate failure mark the trigger `skipped` with
  `skipReason: 'health_gate_error: <msg>'`.
- [ ] **Typed `CaptureBusyException` instead of string-match**
  (`capture-trigger-registry.ts:823-834`). `message.includes('already
  active')` decides busy → `queued` vs generic error → `skipped`. Locale
  change / refactor of the error text silently flips every contention
  into one-shot failure. Throw a typed exception from
  `MonitorCaptureService.startSession`; `instanceof`-check.
- [ ] **`firedSessionId` should reflect terminal session status**
  (`capture-trigger-registry.ts:818-822`). Trigger flips to `fired` the
  instant `startSession` resolves. If the session later fails, the
  trigger row stays `fired` pointing at a `failed` session. Either add a
  terminal `fired_failed` state populated when `MonitorCaptureService`
  finalises a failed session that has a `triggerId`, or join against
  `capture_sessions.status` in the `/monitor/triggers` response.
- [ ] **License-gate + DemoMode coverage at controller level**. The
  controller spec instantiates `MonitorController` directly, bypassing
  the Nest pipeline → `@UseGuards(LicenseGuard)` +
  `@RequiresFeature(MONITOR_ANOMALY_TRIGGER)` on the three trigger
  endpoints are never exercised. Use `Test.createTestingModule`; assert
  402/403 on community-tier license.
- [ ] **Pre-load active triggers once per tick**
  (`capture-trigger-registry.ts:785-789`). `findActiveTrigger` runs 2
  storage queries *per anomaly event* inside the per-event loop. With
  `maxPerTick = 5000` that's up to 10000 SELECTs per tick. Fetch
  configured+queued triggers once at the top of `processNewAnomalies`;
  match in-memory.
- [ ] **Validate `metricType` and `anomalyType` against canonical
  anomaly enums** at the create-DTO boundary. A typo (`'connetions'` vs
  `'connections'`) silently never matches; the trigger sits `configured`
  → `expired` after 24h. Reject unknown values with
  `BadRequestException` listing the valid set.
- See also C1 (`StoredCaptureTrigger` union), C3
  (`MONITOR_TRIGGER_POLL_MS` Zod), C9 (atomic claim, partial unique
  index), C13 (DemoModeGuard coverage).

### PR #181 — trigger.created + session.skipped webhooks

- [ ] **Rename `monitor.session.skipped` → `monitor.trigger.skipped`**
  (`packages/shared/src/webhooks/types.ts`). The event fires from
  `tryFire` when the gate denies — *no session was ever started*. The
  current name implies a session entity existed; SIEM dashboards keyed
  on `session.*` vs `trigger.*` namespaces will miscategorise. Cheap
  pre-launch, breaking change later.
- [ ] **Promote `monitor.trigger.skipped` to Pro tier** (`types.ts:88`).
  Today community-tier; only Pro triggers produce it, so a community
  subscriber receives zero events and assumes the webhook is broken.
  Tier should match the producing feature.
- [ ] **Add the missing trigger lifecycle events**:
  `monitor.trigger.fired` (mandatory — pairs with `trigger.skipped`),
  plus `monitor.trigger.cancelled` and `monitor.trigger.expired`.
  Subscribers who keyed off `monitor.trigger.created` to provision
  resources never learn the trigger terminated.
- [ ] **Dispatch the `start_failed` skip path or document the gap**
  (`capture-trigger-registry.ts:276-279`). The `start_failed: <msg>`
  branch flips the trigger to `skipped` but never calls
  `dispatchSessionSkipped`. Either dispatch (with
  `reason: 'start_failed'`) or document with a negative test.
- [ ] **Fix the create-then-cancel race in `dispatchTriggerCreated`**
  (`capture-trigger-registry.ts:131`). `void` makes dispatch a
  microtask scheduled after `saveCaptureTrigger`. A `cancelTrigger`
  between save and dispatch results in `trigger.created` being sent for
  an already-cancelled trigger. Re-read trigger status inside the
  dispatch helper; skip if not `configured`.
- [ ] **Validate `skipped.reason` against an allowlist; distinguish
  `health_gate_blocked` from `health_gate_unavailable`**
  (`capture-trigger-registry.ts:247, 344`). Today `gate.skipReason ??
  'health_gate_blocked'` accepts any string and swallows the case where
  the gate threw. Validate against `HealthGateSkipReason | 'unknown' |
  'health_gate_unavailable'`; on unknown, `logError` and send
  `reason: 'unknown'`.
- See also C1 (`FREE_EVENTS`/`PRO_EVENTS`/`WEBHOOK_EVENT_TIERS` parity),
  C11 (`createdBy` from auth), C12 (`logError` on dispatch failure).

### PR #182 — Triggers tab UI

- [ ] **Tear down the triggers query on license downgrade**
  (`Monitor.tsx:39-45`). When `hasFeature` flips Pro → Community
  mid-session, the polling query already in flight keeps hitting
  `/monitor/triggers` and routing 402s into `showUpgradePrompt` every
  5s. The user can also be stranded on a blank `triggers` tab. On
  `!triggersEnabled`, call `queryClient.removeQueries({ queryKey:
  triggersKey })` and force the tab back to `sessions` via an effect.
- [ ] **Optimistic remove + global cancel-in-flight disable**
  (`triggers-table.tsx:69`). `disabled={cancellingId === t.id}` disables
  only the single row. Same-row double-click can race; the row stays
  visible until the next 5s poll, so a user "double-deletes" before the
  list refreshes (404 silent). Optimistically remove the row on cancel,
  or disable cancel across the entire list while any cancel is in
  flight.
- [ ] **URL state for the Sessions/Triggers tab** (`Monitor.tsx:88`).
  Today `defaultValue="sessions"` is fixed — no `useSearchParams`, no
  deep-link to `?tab=triggers`. Defeats the point of the new
  `monitor.trigger.created` webhook (operators clicking the alert link
  always land on Sessions). Sync the active tab with the URL.
- [ ] **`firedSessionId` should link to the captured session**
  (`triggers-table.tsx:73-75`). Today the column shows `slice(0, 8)`
  with no affordance. Wrap with `<Link
  to={\`/monitor/sessions/${t.firedSessionId}\`}>`.
- [ ] **Tests for the license gate, status-variant matrix, formatter
  guards, and cancel mutation flow**. Minimum: license gate visible vs
  hidden + polling-disabled-when-ungated; each of the 6 status
  variants; cancel → invalidates; cancel rejection → no invalidation +
  button re-enables; `formatRelative` boundary table.
- See also C6 (per-error UX on cancel), C7 (surface query error),
  C14 (defensive formatters, exhaustive status-badge switch with
  `never`, `EVENT_LABELS` fallback).

### PR #183 — Capture-on-next row action + prefilled modal

- [ ] **Fix wrong-connection trigger creation on connection switch**
  (`AnomalyDashboard.tsx:55-70`, `capture-on-next-modal.tsx:48-58`).
  `openCaptureModal` snapshots `currentConnection.id` into modal context
  at click time. If the user changes connection via the global selector
  while the modal is open, Confirm submits with the OLD `connectionId`
  in the body but the NEW one in the `X-Connection-Id` header. Either
  auto-close the modal on connection change, or re-read inside
  `handleConfirm` and abort with a clear message.
- [ ] **Surface success via a toast with a "View triggers" action**
  (`capture-on-next-modal.tsx:53-57`). Today the only success signal is
  the green banner inside the modal; once the user clicks Close the
  `/anomalies` page is visually unchanged and the "Capture next" row
  button still shows — they reasonably doubt the action and either
  navigate to `/monitor` to verify or double-click (→ 409 silent).
- [ ] **Prefix-based invalidation for the triggers query**
  (`capture-on-next-modal.tsx:56`). Today
  `invalidateQueries({ queryKey: ['monitor', 'triggers', context.connectionId] })`
  matches `Monitor.tsx:31` exactly — but the moment Monitor.tsx's key
  grows a filter, invalidation silently misses and the Triggers tab
  shows stale data. Use prefix invalidation
  (`{ queryKey: ['monitor', 'triggers'], exact: false }`); centralise
  the key shape in a shared `monitorKeys` factory imported by both
  files.
- [ ] **Disambiguate "Capture next" on group rows**
  (`AnomalyDashboard.tsx:443-449`). The button inside an expanded
  correlated group calls `openCaptureModal(anomaly, 'group')` with a
  single per-event anomaly. Operators reasonably expect "capture the
  whole group" but the modal arms only one metric. Either move the
  action to the group header (capture-on-any-member) or rename to
  "Capture next on this metric."
- [ ] **Address residual eslint hygiene in `AnomalyDashboard.tsx`**
  (`:195, 228, 229, 233, 200`). PR retained `// Time filter…`, `//
  fallback: 24 h`, `// 60 buckets`, `parseInt(a)` without radix, and a
  fresh `// eslint-disable-next-line react-hooks/purity` around
  `Date.now()`. CLAUDE.md: fix existing eslint errors rather than
  disable-commenting. Lift `now` out of the memo; drop the freeform
  comments.
- [ ] **Test the modal**: payload integrity (single
  `monitorApi.createTrigger` call with exact `{connectionId, metricType,
  anomalyType}` from row context), invalidation key, dual-gate
  visibility (`hasFeature` + license downgrade + missing connection),
  state-reset on close (incl. reopen with different context), 409
  error path, prefill correctness (event vs group rows).
- See also C5 (modal placement under
  `components/pages/anomaly-dashboard/`), C6 (per-error UX, incl. 409
  dedup map).

### PR #184 — scheduled captures + CaptureScheduler + REST

- [ ] **`lastSkipReason: undefined` doesn't actually clear the column**
  (`capture-scheduler.ts:638-642`, `postgres.adapter.ts:969-972`,
  `sqlite.adapter.ts:1136-1139`). Success path writes
  `lastSkipReason: undefined`; adapters guard with `patch.lastSkipReason
  !== undefined` and drop the field. A healthy schedule that just
  recovered from `memory_above_threshold` displays the stale reason
  indefinitely. Use a `null` sentinel that adapters translate to a real
  `NULL`, or always write the column.
- [ ] **Per-row try/catch in `onModuleInit` restore**
  (`capture-scheduler.ts:518-522`). One row's `addInterval` throw aborts
  the loop; rows after N never restore; Nest crash-loops the pod; no
  `lastSkipReason: 'restore_failed: <msg>'` is persisted. Wrap each
  iteration; log per-row with errorId; mark the bad row; continue.
- [ ] **Add `CaptureScheduler.updateSchedule(id, patch)` and make
  `StoragePort.updateScheduledCapture` `@internal`**
  (`storage-port.interface.ts:494-499`). Today `ScheduledCapturePatch`
  allows mutating `intervalSeconds` but no scheduler method re-registers
  the timer. The first PATCH endpoint to land silently desyncs the
  timer map from storage. Route mutations through the scheduler;
  rename / mark the raw storage method so other modules can't bypass.
- [ ] **`fireOnce` exposed as a public method** (`capture-scheduler.ts:575`).
  Documented as a test seam but reachable from any in-process
  collaborator — a future controller could expose it, bypassing the
  license gate (which lives on the controller, not the scheduler). Mark
  `@internal`, prefix `_`, or move behind a test-only DI override.
- [ ] **Cross-field validation: `intervalSeconds * 1000 > durationMs +
  headroom`** (`capture-scheduler.ts:657-676`). `{ intervalSeconds: 10,
  durationMs: 900_000 }` passes individual bounds (≥10s, ≤15min) but
  produces a schedule that perpetually skips itself via
  `hasActiveSessionOn`. Reject at create time. Same place should reject
  non-integer `intervalSeconds` / `durationMs` (today floats are
  silently truncated by Sqlite and rejected by Postgres → inconsistent
  backend behaviour).
- See also C1 (`ScheduleSpec` union, `LastOutcome`), C9 (atomic claim /
  leader election), C12 (sanitize/redact errors persisted to
  `lastSkipReason`).

### PR #185 — Scheduled tab UI + cron expression

- [ ] **Fix the cron migration for PR-19 deployments**
  (`sqlite.adapter.ts:1450-1483`, `postgres.adapter.ts:1696-1729`).
  `CREATE TABLE IF NOT EXISTS` doesn't re-evaluate column definitions or
  table-level CHECKs on existing tables. Today's `ADD COLUMN
  cron_expression` migration leaves the prior `interval_seconds INTEGER
  NOT NULL CHECK (...)` intact — so cron-only inserts on an upgraded
  deployment fail with `NOT NULL violation`, and the new XOR CHECK
  never applies. **P0 for any deployment that already ran PR 19.**
  Either rebuild the table (`CREATE TABLE _new` + `INSERT SELECT` +
  rename) or `ALTER COLUMN interval_seconds DROP NOT NULL` plus a fresh
  CHECK. Add adapter tests for the legacy → `initialize()` path.
- [ ] **Make cron timezone explicit** (`capture-scheduler.ts:236, 314`).
  `new CronJob(expr, fn)` defaults to Node process timezone — prod
  (UTC) vs dev (operator-local) interpret `"0 9 * * *"` differently.
  Add an IANA `timezone: string` field to the `cron` arm of the
  schedule (default `'UTC'`); pass `{ timeZone }` to `CronJob`; surface
  in the modal and cadence label; persist on the row. Document DST
  behaviour for `0 2 * * *` (spring-forward zero-fire, fall-back
  double-fire).
- [ ] **Enforce a minimum cadence on cron**
  (`capture-scheduler.ts:288-318`). `validateCron` accepts `* * * * *`
  (every minute) and 6-field forms like `* * * * * *` (every second).
  Pathological cadences silently fall into a `session_already_active`-
  skip loop → user sees a schedule that "does nothing useful." Compute
  the next 2-3 fire times from the parsed expression; derive the min
  delta; reject when `< MIN_INTERVAL_SECONDS`. Surface the derived
  cadence.
- [ ] **Replace live `new CronJob(...)` with a pure parser for
  validation** (`capture-scheduler.ts:310-318`). Today `validateCron`
  constructs a real `CronJob` with `start=false` purely to check syntax.
  A future positional signature drift (the `cron` API changed shape
  across v2→v3→v4) could silently start the validation "job." Use
  `cron-parser`'s `CronExpressionParser.parse` for pure validation;
  reserve `CronJob` for live registration.
- [ ] **Sweep legacy `monitor-schedule-` timer prefix on init**
  (`capture-scheduler.ts:21-22, 251-257`). PR renames the prefix to
  `monitor-schedule-interval-` / `monitor-schedule-cron-`. On rolling
  deploys, any timer registered under the old prefix is orphaned —
  `onModuleDestroy` only deletes new-prefix names. Scan
  `registry.getIntervals()` for the legacy prefix in `onModuleInit` and
  delete.
- [ ] **Storage round-trip + migration tests for `cron_expression`**.
  No test today persists a cron-only schedule; regressions in the new
  placeholder shift, JSONB readback, or `toOptionalNumber` ship
  silently. Add: cron save→get round-trip; interval→cron swap via
  `updateScheduledCapture`; DB-level rejection of XOR-violating rows;
  legacy-schema → `initialize()` migration test asserting
  `PRAGMA table_info` contains `cron_expression`.
- [ ] **Cron validation matrix**: today's spec covers one valid / one
  invalid string. Expand to: 5-field, 6-field with seconds, aliases
  (`@daily`, `@hourly`) — pin whether accepted; 4-field (invalid);
  empty string; whitespace-only; very long pathological string;
  pathological-but-valid `* * * * *` (assert accepted and flag the
  foot-gun); DST-relevant `0 2 * * *`.
- See also C1 (`ScheduleSpec` union, `ScheduledCapturePatch` kind-flips,
  `LastOutcome`), C2 (Postgres coverage), C6 (per-error UX in
  `CreateScheduleModal`).

### PR #186 — capture-vs-capture diff + compare UI

- [ ] **Reject cross-connection diffs**
  (`cross-reference.engine.ts:252-305`,
  `monitor.controller.ts:346-369`). Neither engine nor controller
  compares `session.connectionId` against `baselineSession.connectionId`.
  Frontend filters by connection; CLI / automation / direct API hits
  bypass. Worst silent-failure mode — no error, plausible-looking
  output, meaningless conclusions ("staging has 412 new shapes vs prod").
  Add `BadRequestException` after the existence checks.
- [ ] **Add `same-connection` and `empty-baseline` tests in
  `cross-reference.engine.spec.ts`**. Today the engine spec covers
  partial-overlap only. Pin: A on `conn-A` + B on `conn-B`; A non-empty
  + B empty; scripted-command shape preservation through
  capture-baseline path (`EVAL:<sha>` from A absent in B appears in
  `newShapes` with SHA intact); slowlog/ACL "evaluated" flag.
- [ ] **Test `CompareCapturesPanel`**: dropdown population (filtered to
  current connection, excludes self, only completed/truncated), Compare
  button gating, error-state rendering (diff + candidates),
  empty-candidates copy, baseline session-id ellipsis + start
  timestamp.
- See also C1 (`baseline.window` union), C5 (component placement),
  C6 (per-error UX), C7 (`candidatesError` banner),
  C8 (server-side baseline-completed enforcement + empty baseline +
  `evaluated: false` flag for capture-vs-capture).

### PR #187 — data-retention pruning hooks

- [ ] **`pruneOldCaptureChunks` must respect parent session status**
  (`sqlite.adapter.ts:4115-4118`, `postgres.adapter.ts:4364-4367`,
  `memory.adapter.ts:179-183`). Today chunks are deleted purely by
  `last_ts < cutoff` with no session-status awareness. A 14-day session
  still `running` on a 7-day cutoff loses its first 7 days of chunks
  mid-stream; `getCaptureChunks(sessionId)` returns silently truncated
  data. Fix: `AND session_id NOT IN (SELECT id FROM capture_sessions
  WHERE status = 'running')`, or prune chunks only after their owning
  session is in a terminal state.
- [ ] **Enable `PRAGMA foreign_keys = ON` on the SQLite adapter**. The
  `capture_chunks.session_id REFERENCES capture_sessions(id) ON DELETE
  CASCADE` is decorative without the pragma — sessions deleted without
  cascading the chunks, leaving orphans until their own `last_ts`
  cutoff. Set the pragma once at connection setup; matches Postgres
  semantics.
- [ ] **`pruneOldScheduledCaptures` should use
  `GREATEST(created_at, last_fired_at)`** (`postgres.adapter.ts:248`,
  `sqlite.adapter.ts:299`). Today the query uses only `created_at`, so
  a long-lived schedule disabled yesterday but created two years ago is
  pruned immediately on Community tier. Coalesce against
  `last_fired_at` so retention reflects when the schedule was last
  useful.
- See also C2 (Postgres coverage), C9 (leader election / advisory lock
  around `runRetention()`), C10 (zombie-detection, preserve failed
  sessions), C12 (`logError` + errorId, typed
  `StorageNotInitializedError`).

### PR #188 — provider warnings + ACL snippet polish

- [ ] **Surface clipboard `writeText` failures with a manual fallback**
  (`preflight-panel.tsx:309-317`). Today the bare `catch {}` absorbs
  `TypeError` (`navigator.clipboard` undefined on `http://`),
  `NotAllowedError`, `SecurityError`, sandbox rejects — without any
  user-visible signal. Operator clicks "Copy snippet" → nothing →
  pastes stale clipboard into `redis-cli`. Add an inline `'failed'`
  state; branch on `NotAllowedError`/`SecurityError`/other; surface a
  manual select-all hint; `logForDebugging` with an errorId.
- [ ] **Defensive `hasMonitor === true / false / undefined` branching in
  `AclBanner`** (`preflight-panel.tsx:107-146`). Today's strict boolean
  treats "ACL probe failed" identically to "+monitor missing" — an
  operator whose redis is firewalled or auth-rejected gets a confident
  "ACL is missing the +monitor permission" banner and an irrelevant
  `ACL SETUSER` snippet they'll happily execute. Until the C1
  `'unknown'` arm lands, branch defensively now.
- [ ] **Cleanup `setTimeout` on unmount in `CopyableSnippet`**
  (`preflight-panel.tsx:147, 313`). The 1.5s flip back has no cleanup.
  If the user navigates away within that window, the timer holds the
  closure; in StrictMode dev it survives unmount and fires
  `setCopied(false)` on a dead component. Track in a ref; clear in a
  `useEffect` cleanup.
- [ ] **Centralize + telemetry on provider docs URLs**
  (`preflight-panel.tsx:15-22, 114-122`). AWS / GCP / Redis Cloud /
  Upstash docs URLs rot regularly; today they are inline literals with
  no fallback and no `logEvent` to detect dead links. Centralize in
  `apps/web/src/constants/provider-docs.ts` with a "last verified"
  comment; `logEvent('preflight.provider_docs_clicked', { provider, url
  })` on click; consider a server-side `/r/docs/elasticache-restricted`
  redirect so the team can patch URLs without a frontend deploy.
- [ ] **Frontend tests for `ProviderBanner` / `AclBanner` /
  `CopyableSnippet`**. Minimum: each managed provider renders the right
  docs link; self-hosted/unknown render the quiet line; `hasMonitor:
  false` shows the amber snippet, `true` shows the minimal line; Copy
  button success → "Copied" → 1.5s revert (with `vi.useFakeTimers()`);
  Copy rejection keeps `copied: false` and does not throw.
- See also C3 (`MONITOR_PROVIDER_OVERRIDE` Zod + non-prod gate),
  C5 / C15 (split `preflight-panel.tsx`), C8 (`unknown` vs
  `self-hosted` rendering), C14 (`RESTRICTIONS[override] ?? []`).

### PR #189 — optional value-redaction toggle

- [ ] **`redaction_mode` on `capture_sessions` + UI badge + per-writer
  warn log on unscrubbed verbs**
  (`value-redactor.ts:35-65, 84`, `iovalkey-monitor-source.ts:19`).
  Today `MONITOR_REDACT_VALUES=true` is captured once at writer
  construction but never recorded on the session. ~21 verbs are
  scrubbed; everything else (XADD, ZADD, BITFIELD, BITOP, EVAL, MIGRATE,
  RESTORE, etc.) falls through silently. Operators reading the PR title
  reasonably believe "values are redacted" — they aren't. Add a
  `redaction_mode: 'off' | 'partial' | 'unknown'` column, default
  historical rows to `unknown`, surface in the session DTO and UI
  badge, `logger.warn` once per writer at session start listing the
  unscrubbed verbs.
- [ ] **Add strategies for secrets-in-args verbs**
  (`value-redactor.ts:42-65`). `AUTH <password>`, `HELLO ... AUTH user
  pass`, `CONFIG SET requirepass/masterauth <pw>`, `MIGRATE ... AUTH
  <pw>`, `ACL SETUSER user > <password>`, `EVAL <script>`, `SCRIPT LOAD
  <body>`, `FUNCTION LOAD <code>`, `RESTORE key ttl <rdb-blob>` are all
  leaked verbatim under the current toggle. Highest-risk targets a
  redaction feature should cover. Add explicit per-verb strategies;
  update `.env.example` to list covered vs unhandled verbs; surface the
  list at the API too.
- [ ] **Buffer-typed args contract** (`value-redactor.ts:88`,
  `iovalkey-monitor-source.ts:20-24`). `String(args[0] ?? '').
  toUpperCase()` works for the verb lookup but per-arg `args[i]` may be
  a `Buffer` if iovalkey is configured with a binary-safe decoder.
  Strategies slice/copy but `formatMonitorLine` later does `String(a)`
  — produces `[object Object]` or lossy decode on non-UTF-8 bytes.
  Either narrow the input contract (assert strings; `logError` + skip
  line on non-string) or document the iovalkey decode mode this PR
  depends on.
- [ ] **Wiring test for `iovalkey-monitor-source.ts` with redaction
  enabled** (`apps/api/src/monitor/__tests__/`). Today 20 unit tests
  cover the pure redactor; nothing asserts the source actually invokes
  `redactWriteCommandArgs` when `MONITOR_REDACT_VALUES=true`. Stub
  `Valkey.monitor()` returning an `EventEmitter`; emit fake events in
  both env states; assert the emitted `'line'` payload shape
  end-to-end.
- [ ] **Non-colliding placeholder** (`value-redactor.ts:12`). The
  literal `<redacted>` is indistinguishable from a genuine value of the
  same string. Low practical impact but `find captures with redactions`
  queries get false positives. Use `<betterdb:redacted>` (or a
  zero-width marker), or stop relying on the literal and record the
  redacted-arg position per chunk so forensic queries can be exact.
- [ ] **Cover excluded verbs explicitly in tests + named in
  `.env.example`**. Today excluded grammars (XADD / ZADD / BITFIELD /
  BITOP) are mentioned abstractly and not asserted as pass-through in
  the spec. List the unhandled verbs inline in the env-example
  trade-off note; add explicit `toEqual(unchanged)` assertions for
  representative excluded verbs so a future contributor who adds a
  partial strategy doesn't forget to flip the `redaction_mode` marker.
- See also C2 (Postgres coverage for `redaction_mode` column), C3
  (`MONITOR_REDACT_VALUES` Zod).

---

## Recurring themes (high-level, apply across multiple PRs)

These are patterns that recurred in every review. Not standalone tasks
but rules that any of the above items should respect:

- **CLAUDE.md violations**: every PR repeats one-line `if return`
  statements, JSDoc on internal symbols, inline `// 50 MB` comments,
  and `Record<string, any>` types. Address as part of whichever
  follow-up touches the file.
- **Storage shape leaks to HTTP**: every endpoint that returns
  `StoredCaptureSession` directly is making the storage row part of
  the public API. A `MonitorSessionDto` (ideally a discriminated
  `RunningSessionDto | FinalizedSessionDto`) at the controller
  boundary fixes it for all routes at once.
- **Branded IDs**: `ConnectionId`, `SessionId`, `NodeId`, `TriggerId`,
  `ScheduleId` are all `string` end-to-end. Service modules manipulate
  them positionally in many places (e.g.
  `startSingleSession(session.connectionId, targetNodeId)`). Brand them
  in `@betterdb/shared` once; every site benefits.
