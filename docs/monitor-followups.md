# MONITOR — Post-Launch Follow-ups

Tracking list of cleanups and improvements identified during the per-PR review
pass on the MONITOR stack (PRs #163–#190).

Items are grouped by the PR review that surfaced them. None block launch —
they are intentional deferrals, captured here so they don't get lost.

Mark items `- [x]` as they land.

## From PR #165 review — HealthGate deep module + diagnostic endpoint

- [ ] **Rename `GET /monitor/_diag/health-gate` → `GET /monitor/health-gate/check`.**
  The `_diag` prefix is a fabrication used only in this single route; the spec's
  claim that it follows a `system.controller.ts` convention is incorrect (no
  such convention exists). The endpoint also isn't a "diagnostic" — it
  evaluates the gate decision for a given connection. Update controller path,
  method name (consider `checkHealthGate`), spec doc, and `docs/monitor.md`
  REST surface section.

## From PR #166 review — ProviderDetector + AclChecker + pre-flight endpoint

- [ ] **Drop the `callPort` indirection in `apps/api/src/monitor/acl-checker.ts:76-86`.**
  The local `DatabasePortLike` interface (lines 72–74) duplicates the existing
  `DatabasePort.call` signature from
  `apps/api/src/common/interfaces/database-port.interface.ts:86`. The
  `client: unknown` parameter discards a known type, and the
  `typeof c?.call !== 'function'` guard defends against a scenario that can't
  happen (`ConnectionRegistry.get()` returns a typed `DatabasePort`). Replace
  with a direct `client.call('ACL', […])` call site, import `DatabasePort` for
  explicit typing. Net change: −15 lines, no behavior change.

- [ ] **Convert `AclCheckResult` to a discriminated union with explicit
  `'unknown'` state** (`apps/api/src/monitor/acl-checker.ts:4-13`). Today the
  type is `{ hasMonitor: boolean; setUserSnippet?: string; … }`. The catch
  blocks at `:39, 47` collapse three distinct failures (WHOAMI failed, GETUSER
  permission-denied, connection dropped) into `hasMonitor: false` with a
  remediation snippet that won't actually fix the problem. Replace with:

  ```ts
  type AclCheckResult =
    | { username; hasMonitor: true;  rawRules? }
    | { username; hasMonitor: false; setUserSnippet: string; rawRules? }
    | { username; hasMonitor: 'unknown'; probeError: string };
  ```

  UI then renders "couldn't determine — check server logs" instead of a
  misleading `ACL SETUSER default +monitor`. Also bump the swallowed-error log
  lines at `:39, 47` from `debug` to `warn` so the failure is visible in
  production.

- [ ] **Validate request bodies on monitor controller endpoints with
  class-validator DTOs.** Today `StartSessionRequestBody`,
  `PreflightRequestBody`, and `CreateTriggerRequestBody` are plain interfaces
  with all-optional fields; only `connectionId` is hand-checked. Negative /
  NaN / Infinity / over-cap values for `durationMs`, `byteCap`, `lineCap` flow
  straight through to the writer where #167's silent fallback to default kicks
  in. Migrate the four endpoint bodies to DTO classes with `class-validator`
  decorators (`@IsInt() @Min(1000) @Max(3_600_000) @IsOptional()` etc.) and
  add a `ValidationPipe`. Affects:
  - `monitor.controller.ts:38-67` (start session)
  - `monitor.controller.ts:112` (preflight)
  - Any other monitor endpoint accepting numeric body params

- [ ] **Consolidate `DEFAULT_DURATION_MS`** — currently defined in two places:
  `apps/api/src/monitor/preflight.service.ts:12` and
  `apps/api/src/monitor/monitor-capture.service.ts:17`. Both are `30_000`.
  Move to `packages/shared` (e.g. `packages/shared/src/monitor/defaults.ts`)
  and import from both call sites, so the API default and the web
  start-session-modal default share a single source of truth.

- [ ] **Use `Promise.allSettled` in PreflightService**
  (`apps/api/src/monitor/preflight.service.ts:64`). Currently
  `Promise.all([aclChecker.check, healthGateService.evaluate])` makes a
  transient INFO failure in `HealthGateService` kill the entire preflight
  including the successful provider/throughput sections. Switch to
  `Promise.allSettled` and surface per-section status
  (`{ status: 'ok', data } | { status: 'error', reason }`) so the operator
  sees what we could determine. Same pattern applies to the throughput
  section when `INFO stats` is redacted by a managed provider — return
  `{ available: false; reason }` instead of silently returning zeros.

## From PR #167 review — CaptureWriter + storage chunk persistence

- [ ] **Surface chunk-persistence failures as a session-row signal**
  (`apps/api/src/monitor/capture-writer.ts:174-178`). Today a rejected
  `saveCaptureChunk` is `.catch()`-swallowed with a `logger.error` and the
  session is still finalized as `status: 'completed'`. Metadata reports "100
  lines captured" while the chunk export contains 60. Add a
  `chunkPersistFailures: number` counter on the writer, include it in the
  finalize patch (`terminationReason` of `completed_with_persistence_errors:N`,
  or a new `persistenceErrors` column), and consider auto-escalating `status`
  to `'failed'` past a configurable threshold so operators don't see a
  misleading green checkmark on a lossy capture.

- [ ] **Surface `updateCaptureSession` failure to the caller**
  (`capture-writer.ts:225` finalize patch). If the final patch rejects, the
  row stays `status='running'` forever even though the writer has fully
  terminated. Caller / UI list a zombie capture. Add `finalizeError?: string`
  to `CaptureWriterResult`, retry once with backoff, and emit `logError` with
  a stable errorId so it lands in Sentry. Optionally add a janitor in the
  service layer that re-finalizes stuck `running` sessions older than 2× their
  `durationMs`.

- [ ] **Convert `terminationReason` to a discriminated union** in
  `packages/shared/src/types/monitor.ts:25,41,143` and
  `apps/api/src/monitor/capture-writer.ts:60`. Currently
  `terminationReason: string` accepts `'manual_stop'`, `'byte_cap'`, the
  concatenated `'source_error: connection lost'` (built at
  `capture-writer.ts:157`), and any user-supplied stop reason. UI cannot
  reliably switch on it; analytics resort to `LIKE 'source_error:%'`. Replace
  with:

  ```ts
  type TerminationReason =
    | { kind: 'byte_cap' | 'line_cap' | 'duration_cap' | 'manual_stop' | 'source_ended' }
    | { kind: 'source_error'; message: string };
  ```

  Also: truncate / redact `err.message` before storage (AUTH errors can leak
  credentials) and emit `logError` with a stable errorId on the source-error
  path.

- [ ] **Add postgres adapter coverage for the capture-storage methods.** The
  new `saveCaptureChunk`, `updateCaptureSession`, and `getCaptureChunks`
  implementations at `apps/api/src/storage/adapters/postgres.adapter.ts`
  (around lines 4077, 4122, 4413) have **zero spec coverage** —
  `capture-sessions.spec.ts` `describe.each` runs only against Sqlite +
  Memory. The postgres `updateCaptureSession` is a real partial-update SQL
  builder, the highest-risk surface in the writer stack. Either extend
  `describe.each` to include a docker-compose postgres (port 6383 is already
  used by anomaly tests) or add a dedicated integration spec under
  `pnpm test:integration`.

- [ ] **Expose dropped-line counters**
  (`apps/api/src/monitor/capture-writer.ts`). Two distinct silent-drop paths
  today: (a) ring-buffer FIFO eviction at 10000 lines (line 187 — operator
  can't tell why their live-tail jumped backward in time), (b) lines dropped
  after `stopped=true` between cap-detection and source-halt (line 230's
  `if (this.stopped) return`). Add `ringBufferDroppedCount` and
  `droppedAfterTermination` to the writer's `getCounters()` output and surface
  them in the session row / live-tail UI so operators can correlate gaps to
  real causes.

## From PR #168 review — start/stop/get session endpoints + Valkey MONITOR wiring

- [ ] **Fix TOCTOU race on active-session map in `startSession`**
  (`apps/api/src/monitor/monitor-capture.service.ts:425-450`). Today the flow
  is `if (active.has(c)) throw 409 → await saveCaptureSession → await
  monitorSourceFactory → active.set(c, ...)`. Two parallel POSTs for the same
  `connectionId` both pass the `has()` check, both insert rows, both open
  MONITOR connections; the second `set` overwrites the first — leaks the
  first dedicated iovalkey socket and orphans its session row. Fix: reserve
  the slot synchronously (`active.set(c, placeholder)` immediately after the
  conflict check) and clean up the slot on every failure path. Add a
  `Promise.all([start(c), start(c)])` race test.

- [ ] **Close the MONITOR socket on writer construction / start failure**
  (`monitor-capture.service.ts:450-485`). If `saveCaptureSession` succeeds and
  `monitorSourceFactory` opens the dedicated iovalkey connection but then
  `new CaptureWriter(...)` throws or `writer.start()` rejects, the socket is
  never `.disconnect()`-ed and the row sits `running` indefinitely. Wrap
  writer construction + `.start()` in a try/catch that calls
  `monitorSource.stop()` and patches the row to `status:'failed'` with
  `terminationReason: 'writer_init_failed: <msg>'`.

- [ ] **Detect iovalkey auto-reconnect during MONITOR mode**
  (`apps/api/src/monitor/iovalkey-monitor-source.ts:284-303`).
  `client.monitor()` reconnects by default on socket drop, but the new socket
  is **not** in MONITOR mode (per-connection state). The wrapper keeps
  `stopped=false`, emits nothing, the writer never finalizes — silent
  zero-traffic capture. Either pass `{ retryStrategy: () => null }` so a drop
  becomes a hard `error`/`end`, or hook `monitor.on('reconnecting', ...)` and
  force-emit `'error'` so the writer terminates with a real reason.

- [ ] **Escape control characters and handle Buffer args in
  `formatMonitorLine`** (`iovalkey-monitor-source.ts:325-337`). `escapeArg`
  only escapes `\` and `"`. Real Valkey args can contain `\n`, `\r`, NUL, raw
  0x80+ bytes (binary values). The wrapper writes them verbatim into the
  persisted text, which (a) breaks the `\n`-delimited storage assumption from
  PR #167 (one MONITOR event becomes two stored lines), (b) yields invalid
  UTF-8 in chunks, (c) `String(arg)` on a `Buffer` produces
  `"[object Object]"` or a lossy Latin-1 decode. Match `valkey-cli`'s
  octal-escape behavior (`\xNN`) for all control chars and handle `Buffer`
  args explicitly. Add table-driven unit tests — the formatter is currently
  not exported and not unit-tested at all.

- [ ] **Anchor `DemoModeGuard` prefix matching on path boundaries**
  (`proprietary/cloud-auth/demo-mode.guard.ts:48`). `apiPath.startsWith(p)`
  falsely matches `/monitor/sessions-extra`, `/monitor/sessionsXYZ`,
  `/monitor/sessions-archive` against `/monitor/sessions`. Today there are no
  such routes, but the moment one is added it silently inherits the demo-mode
  block (or, worse, an intended-block path silently leaks through if the
  prefix shifts). Replace with
  `apiPath === p || apiPath.startsWith(p + '/')`. Same issue affects every
  entry in both `DENIED_MUTATION_PREFIXES` and the allow-list — fix once,
  applies to all.

- [ ] **Derive `requestedBy` from the authenticated principal, not the
  request body** (`monitor.controller.ts:551-575`). Today any caller can put
  any value in `requestedBy` and it flows into the audit history unchanged.
  Strip it from the DTO and read from `@User()` decorator (or equivalent in
  the cloud-auth integration) instead. Reject body input even if provided.

## From PR #169 review — session lifecycle webhooks (started/completed/truncated)

- [ ] **Migrate `MONITOR_DEFAULT_BYTE_CAP` and `MONITOR_DEFAULT_LINE_CAP` to
  the Zod schema** (`apps/api/src/monitor/monitor-capture.service.ts:18-25`).
  Today both are read raw via `process.env` at module load time and run
  through a local `parsePositiveInt(raw, fallback)` helper that silently
  falls back on `'abc'`, `'-1'`, `'0'`, `'1.5'`. Same anti-pattern PR #165
  fixed for the health-gate env vars. Add
  `MONITOR_DEFAULT_BYTE_CAP: z.coerce.number().int().positive().default(52428800)`
  and the line-cap equivalent to `env.schema.ts`, inject via `ConfigService`
  in the service constructor, delete the local `parsePositiveInt` helper.

- [ ] **Sanitize `terminationReason` before webhook dispatch**
  (`monitor-capture.service.ts:286`). The field currently flows verbatim into
  `completed` / `truncated` payloads. If a future code path lets a
  `failed`-tagged reason (e.g. `source_error: NOAUTH cannot run MONITOR`)
  persist into a subsequent terminate call, the raw AUTH error message goes
  out to whatever HTTP endpoint the user configured. Pairs with the
  discriminated-union conversion above — once `TerminationReason` is a tagged
  union, the webhook dispatcher serializes only the kind (and a sanitized /
  truncated message for `source_error`).

- [ ] **Distinguish writer-error vs dispatch-error in the finalize chain**
  (`monitor-capture.service.ts:141-151`). The current chain
  `writer.start().then(dispatch).catch(log).finally(clear)` collapses both
  failure modes into one log line and `stopSession()` resolves cleanly in
  both cases. A dispatch failure after the writer has finalized = row is
  terminal, webhook never went out, no `webhook_deliveries` row exists, only
  trace is a single `logger.error`. Split the chain so dispatch errors are
  caught separately, logged with their own errorId, and persisted via the
  existing webhook retry path (or a `dispatch_pending` marker on the session
  row).

- [ ] **Type the webhook payload with a discriminated union and drop
  `Record<string, any>` from the dispatcher signature**
  (`packages/shared/src/webhooks/types.ts:258-264`,
  `apps/api/src/webhooks/webhook-dispatcher.service.ts:112`). The current
  shape `WebhookPayload.data: Record<string, any>` erases all structure and
  is a CLAUDE.md `any` violation. Add per-event payload types
  (`MonitorSessionStartedPayload | MonitorSessionCompletedPayload |
  MonitorSessionTruncatedPayload`) keyed on `event`. Move the dispatch calls
  into a `MonitorWebhookEventsService` with one typed method per event,
  mirroring the existing `IWebhookEventsProService` pattern for Pro/Enterprise
  events. Also: derive `FREE_EVENTS` from `WEBHOOK_EVENT_TIERS` (filter where
  tier === community) so the parallel structures cannot drift, and add a
  `schemaVersion` field to the payload before external consumers subscribe.

- [ ] **Add a community-tier `monitor.session.failed` event** (or at minimum
  bump the writer-error log to `warn` with `sessionId`/`connectionId`).
  Today community operators have zero signal when a capture fails — the
  only trace is `this.logger.error` in the api container logs. The Pro+
  `monitor.session.skipped` event lands in PR 16 but is Pro+; community-tier
  users running monitor stay blind.

## From PR #170 review — TailGateway WebSocket + pause/resume

- [ ] **Register `ws.on('error', ...)` and handle `ws.send` failures**
  (`apps/api/src/monitor/tail.gateway.ts`). The gateway listens only for
  `'close'`; every `ws.send(...)` is fire-and-forget with no callback. A
  failed send emits `'error'` on the `ws` EventEmitter; with no listener the
  error is silently dropped, and in the live-stream path the subscriber
  callback keeps firing into a broken socket for every subsequent line —
  unbounded waste, no operator signal. Add `ws.on('error', (err) => {
  logger.warn(...); cleanup(); ws.terminate(); })` at the top of
  `handleConnection`, and unify the close/error cleanup so subscribers can't
  leak when only `'error'` fires (some `ws` versions do this).

- [ ] **Apply backpressure on un-paused viewers via `ws.bufferedAmount`**
  (`tail.gateway.ts:128-141`). The 50 000-line cap only protects
  **explicitly paused** viewers. An un-paused slow consumer makes Node's
  `ws` lib buffer in JS until the OS socket buffer fills, then keeps
  buffering — the API process heap grows without bound. When
  `ws.bufferedAmount > THRESHOLD`, either pause-buffer with the same cap or
  `ws.close(1013, 'slow consumer')` and emit an operator-visible warning.

- [ ] **Signal pause-buffer overflow to the viewer**
  (`tail.gateway.ts:294-300`). At 50 000 lines, `pausedBuffer.shift()` drops
  the oldest line with no log, no metric, no client-visible signal. On
  resume the viewer sees an unexplained gap. Track
  `droppedWhilePausedCount`, log at WARN when it first crosses zero, and on
  resume send `{type:'status', status:'buffer_overflow', droppedLines: N}`
  before draining. Same pattern as the writer-side `droppedAfterTermination`
  counter from the #167 follow-up.

- [ ] **Add tenant / owner verification at the WS handshake**
  (`tail.gateway.ts:191-227`). Currently `sessionId` is the only capability
  — anyone with (or guessing) a sessionId gets the live tail, including for
  another tenant's database. `MonitorCaptureService.getSession` is called
  but the returned session's `requestedBy` / `connectionId` owner is never
  compared to the requestor. Pull the user from the auth-proxy headers and
  reject when `session.requestedBy !== request.user` (or whatever the
  tenant-scope equivalent is). Add a regression test for cross-tenant
  access.

- [ ] **Verify and fix `Host`-header semantics in `handleUpgrade`**
  (`tail.gateway.ts:60-64`). Two distinct problems:
  - **Forgeable**: a direct TCP client sets `Host: anything` — no proxy
    strips it. Same finding as #168 HTTP guard. Trust an auth-proxy header
    (e.g. `X-Forwarded-Host` from a known trusted ingress) rather than
    `Host`.
  - **Likely inverted semantics**: current code *rejects* when
    `host === DEMO_HOSTNAME`, but `DemoModeGuard` for HTTP typically
    *restricts to* the demo host. If `DEMO_HOSTNAME` is ever set on a prod
    deployment for any reason, prod traffic on that host is blocked while
    everything else passes. Cross-check `DemoModeGuard` semantics and
    align.

- [ ] **Type-safe wire contract for the tail WS**: tighten `OutboundMessage`
  status to `'session_ended' | 'historical_complete'` (currently
  `status: string`, defeats the discriminated union); validate inbound
  `ControlMessage` with a Zod schema (currently `JSON.parse(...)` cast to
  the type with zero runtime validation — a hostile client sending
  `{type: '__proto__'}` silently no-ops); and **move both message types to
  `packages/shared`** so `apps/web` consumes the same definitions and
  cannot drift. Files: `tail.gateway.ts:13-26, 114-116`.

- [ ] **Propagate `CaptureWriterResult` through `onEnd`**
  (`apps/api/src/monitor/capture-writer.ts:201`). The callback signature
  is `() => void` even though `CaptureWriterResult` exists. The gateway
  currently sends a flat `'session_ended'` status regardless of whether
  the writer truncated, failed, or completed cleanly. Promote to
  `(result: CaptureWriterResult) => void` and let the gateway send
  `{type:'error', error:...}` for failed sessions and a richer
  `{type:'status', status, terminationReason}` for the rest.

- [ ] **Fix the active-vs-historical subscribe-order race**
  (`tail.gateway.ts:122-141`). Between `getActiveWriter()` (line 73) and
  `writer.subscribe(...)` (line 122), the writer can terminate.
  `subscribe()` then becomes a no-op; `onEnd` fires on a microtask **after**
  the backlog is sent, so the viewer receives backlog + `session_ended`
  instead of falling through to historical replay. Reorder: register
  `onEnd` first, then drain the ring-buffer backlog, then `subscribe`.
  Add a regression test that forces the race (terminate after
  `getActiveWriter` returns, before `subscribe` is wired).

## From PR #171 review — Sessions list with 5s polling (first frontend slice)

- [ ] **Surface fetch errors in the Monitor UI** (`apps/web/src/pages/Monitor.tsx:11-18`).
  The page destructures only `{ data, loading }` from `usePolling`; the
  `error` return is never read. On 4xx/5xx the table shows "No capture
  sessions for this connection yet." — indistinguishable from a real empty
  state. 403 (license), 404 (no connection), 500 (DB down), and network
  failure all collapse into the same UI with no toast, no log, no Sentry
  event. Destructure `error`, render an inline banner ("Failed to load
  capture sessions: <message>. Retrying in 5s."), and call `logError` with
  an errorId.

- [ ] **`SessionStatusBadge` fallback for unknown statuses**
  (`apps/web/src/pages/monitor/session-status-badge.tsx:11-18`).
  `STYLES[status]` is type-safe at build time but a backend deploy that
  introduces a new status (e.g. `'paused'`, `'aborted'`) ahead of a frontend
  release produces `className="... undefined"` with no fallback label.
  Add `const style = STYLES[status] ?? 'bg-muted text-muted-foreground'`
  and a fallback label so the row stays readable. The same pattern applies
  to any other typed-record lookup keyed on a server-controlled enum.

- [ ] **Reuse the existing `formatBytes` utility and make formatters
  defensive** (`apps/web/src/pages/monitor/sessions-table.tsx:84-97`).
  - `formatBytes` is duplicated from `apps/web/src/lib/utils.ts:8` — delete
    the local copy, import the canonical one.
  - `formatDuration` belongs alongside `formatDurationUs` in `lib/utils.ts`
    (or a sibling). Move it there.
  - Both functions need guards: `formatBytes(NaN)` falls through every
    threshold and renders `"NaN GB"`; `formatDuration` returns `0ms` for a
    completed session in the transient state where both `durationMs` and
    `endedAt` are missing post-finalize; `s.lineCount.toLocaleString()` at
    `:70` throws `TypeError` if `lineCount` is ever undefined and crashes
    the entire table. Guard with `Number.isFinite` checks and render `—`
    for missing values.
  - Add Vitest specs alongside `lib/formatters.test.ts` — pure functions
    with magnitude-tier branching; the precedent and infra already exist.
    (Author's "no test infrastructure" claim is incorrect — `apps/web` has
    30+ test files including `lib/formatters.test.ts`,
    `api/commandstats.test.ts`, and `components/pages/cache-proposals/*.test.tsx`.)

- [ ] **Move monitor page components to `apps/web/src/components/pages/monitor/`**.
  CLAUDE.md says "Pages components are in `components/pages` folder."
  Project precedent at `components/pages/inference-latency/`,
  `components/pages/cache-proposals/`, `components/pages/metric-forecasting/`.
  PR #171 put `sessions-table.tsx` / `session-status-badge.tsx` in
  `apps/web/src/pages/monitor/` (continuing a wrong prior precedent at
  `pages/monitor/preflight-panel.tsx` from earlier monitor PRs). Move all
  monitor page-internal components to `components/pages/monitor/` and
  update imports.

- [ ] **Status-badge colors via theme variables, not hard-coded Tailwind
  classes** (`session-status-badge.tsx:4-9`). Today the badges use
  `bg-emerald-500/15 text-emerald-700 dark:text-emerald-300` etc. — exactly
  the "inline color breaks dark-mode adaptation" pattern CLAUDE.md guards
  against for charts. Map to semantic theme variables:
  `running → --chart-info`, `truncated → --chart-warning`,
  `failed → --chart-critical`, `completed → --primary` or `--chart-1`,
  `skipped → --muted`.

- [ ] **Clarify that counters are flushed-not-live in the Sessions table**.
  The 5s polling pulls `byteCount`/`lineCount` from the session row, but
  the writer persists these only on chunk flush. A running session can
  show identical numbers for many polls then jump — operators reasonably
  read the polling cadence as "live" and file bug reports about "stuck"
  captures. Either rename the column header to "Lines (flushed)" /
  "Bytes (flushed)", or add a tooltip / footer indicator showing flush
  cadence + "updated Xs ago" on running rows.

- [ ] **Typed `HttpError` from the API client**
  (`apps/web/src/api/client.ts:161`). The shared client throws an untyped
  `Error` with the status code only embedded in the message string.
  `PaymentRequiredError` (402) is the only typed exception. Frontend
  callers cannot branch on 403 (license required) vs 404 (no such
  connection) vs 500 (server error) to render targeted UI. Introduce
  `class HttpError extends Error { status: number; body?: unknown }` and
  throw it from `fetchApi`. Benefits every monitor page that needs to
  distinguish failure modes.

## From PR #172 review — start-session modal + pre-flight + 5-min confirmation

- [ ] **5-min confirmation guard can be bypassed by editing duration between
  the two clicks** (`apps/web/src/pages/monitor/start-session-modal.tsx:73-94`).
  Today the flow is: first click on a 6-minute session sets
  `confirming=true`; user can then edit duration up to e.g. 999 minutes;
  second click ("Yes, start session") fires *without re-confirmation* because
  the button label and gate only check at submit, never on duration change.
  Fix: invalidate `confirming` whenever `durationMs` changes after entering
  confirm mode (not just when it drops below 5m). The existing
  auto-clear-when-dropping-below-5m effect at `:43-45` already proves the
  hook; extend it to clear on any value change while `confirming === true`.

- [ ] **Pre-flight failure must block start** (`start-session-modal.tsx:189-194`).
  Submit is gated only on `submitting || preflightLoading`, not on
  `!!preflightError`. If pre-flight fetch fails (network / license / 5xx)
  the user can blindly start a session that the backend will then reject —
  defeating the entire purpose of the pre-flight surface. Gate Submit on
  `preflightError === null` (or require an explicit "Start without
  pre-flight" affordance with its own confirmation).

- [ ] **Make `PreflightPanel` defensive against degraded backend responses**
  (`apps/web/src/pages/monitor/preflight-panel.tsx`). Multiple latent
  crashes the moment any of the #166 follow-ups land:
  - `:23` — `PROVIDER_LABELS[preflight.provider.provider]` with no
    fallback renders `undefined` for any new provider value. Same class
    of bug as `SessionStatusBadge` in #171.
  - `:42` — `preflight.acl.hasMonitor` is treated as `boolean`. When the
    `AclCheckResult` discriminated-union follow-up lands (PR #166),
    `hasMonitor === 'unknown'` truthy-renders as "+monitor granted" —
    actively misleading the operator.
  - `:78-86` — throughput section calls `.toFixed` / `.toLocaleString`
    on raw numbers. When the `{ available: false; reason }` follow-up
    lands, `null.toFixed(0)` throws and crashes the modal (no visible
    error boundary). Add per-section null guards and a fallback label
    for unknown enum values.

- [ ] **Add state-machine tests for the 5-min guard and state-reset-on-close**
  (`start-session-modal.tsx`). Author shipped a state-carryover bug once
  already (their own "Bug caught and fixed during live testing" admission
  in the PR body). There is zero regression protection. The `apps/web`
  Vitest + RTL infra is fully present and `cache-proposals/PendingCard.test.tsx`
  is the direct precedent for modal interaction tests. Minimum test matrix:
  - 30s submit → API called immediately
  - 6m first submit → no API call, `confirming=true`, button label changes
  - 6m second submit → API called
  - 6m → drop to 30s → `confirming` clears
  - API rejects → `confirming` resets in `finally`, modal stays open
  - Close at 6m → reopen → input shows 30s default (the carryover bug)
  - Rapid duration edits → only latest preflight result renders (race)

- [ ] **Use `AbortController` for pre-flight fetches + debounce duration
  input** (`start-session-modal.tsx:60-78`). Today the cancelled-flag
  prevents stale `setState` but the underlying `fetch` runs to completion
  on every keystroke. With unit=`s` and rapid typing ("3"→"30"→"300"), three
  pre-flight POSTs hit the backend. Wire an `AbortController` per effect,
  pass `signal` through `fetchApi` (the global client already supports it
  per `apps/web/src/api/client.ts:148`), and debounce duration changes by
  250–300 ms. Closes the modal-close-mid-fetch leak too.

- [ ] **Bound `requestedBy` length and validate duration input client-side**
  (`start-session-modal.tsx:127-135, 152`). Today:
  - `requestedBy` is unbounded free text sent verbatim. Add
    `maxLength={64}` on the input. Cross-reference #168 follow-up: this
    field should ultimately come from the authenticated principal, not
    body input; the UI gives the silent gap a visible surface.
  - Duration accepts `1.5` (durationMs=1500), `1e9`, `999999999`. Add
    `step={1}`, `Math.floor`, and a sane upper bound (e.g.
    session-cap-aware max). Backend currently rejects with a generic 400
    which collapses into the opaque error string (see typed-`HttpError`
    item in the #171 section).

- [ ] **Centralize the 5-minute threshold** (`start-session-modal.tsx:13`
  `FIVE_MINUTES_MS`). Today it's a local magic constant. The same
  threshold likely exists server-side as part of session-cap policy; move
  to `packages/shared/src/monitor/defaults.ts` (the same module already
  proposed for `DEFAULT_DURATION_MS`) so frontend / backend can't drift.

- [ ] **Surface success feedback after Start session**
  (`apps/web/src/pages/Monitor.tsx:53-60`). Today after `onStarted` fires
  and modal closes, the only signal is the new row appearing — which
  depends on `queryClient.invalidateQueries` succeeding (the call is
  `void`-discarded, so failure is silent). Add a toast confirming the
  session started, and `.catch(logError)` the invalidation.

## From PR #173 review — live tail view + pause/resume + bounded buffer

- [ ] **Cancel pending `requestAnimationFrame` on unmount**
  (`apps/web/src/hooks/useMonitorTail.ts:132-141, 199-209`). Cleanup never
  calls `cancelAnimationFrame`; queued callbacks fire after unmount and
  setState on a dead component. Store the handle in a ref, cancel in the
  effect cleanup.

- [ ] **Validate inbound WS frames; log on unknown `type` / parse failure**
  (`useMonitorTail.ts:178-181`). Today `try { JSON.parse } catch { return }`
  silently drops malformed frames; unknown `msg.type` has no `else` branch
  → silent dispatch failure. Backend rename / version mismatch / binary
  frame goes invisible. Use a Zod schema (or narrow guards) and `logError`
  on rejection.

- [ ] **Surface `ws.onclose` code/reason and add reconnect** (`useMonitorTail.ts:164-174`).
  All non-1000 closures map to `closed` with the generic
  `"WebSocket connection error"` text. Handshake-rejected
  (1006/4xxx), server crash mid-stream, and graceful end all look the same
  to the user, with no retry path. Branch on `close.code`, render
  actionable text ("Live tail unavailable — preview disabled / session not
  found / server unreachable"), and add backoff reconnect for transient
  closes.

- [ ] **`historical_complete` / `session_ended` must close the WS**
  (`useMonitorTail.ts:140-142`). Code only updates state; doc/PR
  description claims the socket closes. Additional frames after a terminal
  status are still processed. Call `ws.close()` (with handlers detached)
  on either status frame.

- [ ] **Remove dead `MONITOR_DEV_PREVIEW` route gate post-launch**
  (`apps/web/src/components/layout/AppLayout.tsx:32-41`). The `/monitor/sessions/:id`
  route is still wrapped in `{MONITOR_DEV_PREVIEW && ...}` even though
  commit `9cee378` removed the env flag everywhere else. On master with
  the flag unset, clicking a session row routes to a path with no
  matching `<Route>` — silent black hole. Drop the conditional.

- [ ] **Derive WS URL from `window.location` / Vite proxy, not hardcoded
  `localhost:3001`** (`useMonitorTail.ts:96-99`). Today's dev URL breaks
  Codespaces, LAN-accessed dev, remote dev hosts, IPv6-only. Use Vite's
  dev proxy and hit `/api/monitor/ws` in both prod and dev, or derive host
  from `window.location.hostname`.

- [ ] **`useMonitorTail` hook tests** — the most complex client-side
  stateful logic in the stack has zero coverage; Vitest + RTL `renderHook`
  + `MockWebSocket` infra is already in use (see
  `apps/web/src/hooks/useLicense.test.ts`). Minimum matrix: open →
  `streaming`; line frames flush once per rAF; 5001 lines →
  `bufferTrimmed=true` + last 5000 retained + `totalReceived=5001`;
  `pause`/`resume` send correct control frames and gate on
  `readyState === OPEN`; sessionId swap tears down old socket; unmount
  cancels rAF; StrictMode double-mount leaves one live WS.

- [ ] **Stable key on line list, not index** (`tail-view.tsx:469`). When
  the buffer trims oldest, every row's index shifts → full re-render,
  text selection breaks mid-stream. Use a monotonic id minted at push
  (e.g. `totalReceived - lines.length + i`, or a circular buffer with
  stable ids).

- [ ] **Move WS wire types (`OutboundMessage`, control message) to
  `packages/shared`** (`useMonitorTail.ts:26-38`). Currently re-declared
  on both sides; pairs with the #170 follow-up.

## Recurring themes (apply across multiple PRs)

These are patterns that recurred in every review. They're not standalone tasks
but rather rules that any of the above items should respect:

- **CLAUDE.md violations**: every PR repeats one-line `if return` statements,
  JSDoc on internal symbols, inline `// 50 MB` comments, and `Record<string,
  any>` types. Address as part of whichever follow-up touches the file.
- **Storage shape leaks to HTTP**: every endpoint that returns
  `StoredCaptureSession` directly is making the storage row part of the
  public API. A `MonitorSessionDto` (ideally a discriminated
  `RunningSessionDto | FinalizedSessionDto`) at the controller boundary fixes
  it for all routes at once.
- **Branded IDs**: `ConnectionId`, `SessionId`, `NodeId`, `TriggerId`,
  `ScheduleId` are all `string` end-to-end. The service modules manipulate
  them positionally in many places (e.g.
  `startSingleSession(session.connectionId, targetNodeId)`). Brand them in
  `@betterdb/shared` once, every site benefits.
