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

## From PR #174 review — post-capture filters + JSON/CSV export

- [ ] **CSV formula-injection mitigation** (`apps/api/src/monitor/monitor-line.parser.ts:108-122`).
  A captured Valkey arg like `=cmd|'/c calc'!A1` opens in Excel/Sheets and
  executes — operators downloading forensic CSVs are the target. RFC 4180
  doesn't help. In `csvField`, prefix `=`, `+`, `-`, `@`, `\t`, `\r` with
  `'` and add `\r` to the special-char quote check.

- [ ] **Surface dropped-line count from the export endpoint**
  (`apps/api/src/monitor/monitor.controller.ts:166-180`). Unparseable lines
  are silently `continue`d. `{count: 4823, lines: [...]}` claims success
  when 17 lines were dropped — bad for a forensic export. Track
  `droppedCount`, attach to JSON response, set
  `X-Monitor-Export-Parse-Errors` header, `logError` past a ratio threshold.

- [ ] **Validate `afterTs` / `beforeTs` (and reject unknown `format`)**
  (`monitor.controller.ts:147-150`). Today `parseInt('abc', 10)` → `NaN`
  silently becomes allow-all; `?afterTs=0` is falsy → silently dropped;
  `?format=xls` silently returns JSON. The test at
  `monitor.controller.spec.ts:282-288` codifies the format fallback —
  it's a tripwire against fixing this. Reuse the existing
  `parsePositiveInt` (which already throws `BadRequestException` correctly)
  for timestamps; throw on unknown format; update the spec.

- [ ] **Stream the export instead of accumulating in memory**
  (`monitor.controller.ts:160-198`). Today the controller builds the full
  response as a string/array before `reply.send`. A 50 MB cap peaks at
  ~150-200 MB heap; 500 MB sessions OOM. Switch CSV to `reply.raw.write()`
  chunk-by-chunk and JSON to NDJSON (or a streamed array). Wrap in
  try/catch so a mid-iteration storage rejection translates to a proper
  5xx instead of a half-written 200 body.

- [ ] **Extract `monitor-line.parser.ts` to `packages/shared` (or add a
  frontend/backend parity test)**. The frontend duplicates the parser
  inline at `apps/web/src/pages/monitor/filters-and-export.tsx:106-150`.
  When the backend evolves (IPv6, new escape rule, glob behavior), the
  in-page "Buffer match: N" silently diverges from the export count. Pure
  parser has no Nest deps — it belongs in `@betterdb/shared`. Minimum
  fallback: a parity test running identical line corpora through both
  implementations.

- [ ] **Honest copy on the buffer preview + optional server-side count
  endpoint** (`filters-and-export.tsx:60-66`). The 5000-line live buffer
  is a tiny window of a session that may have millions of lines.
  "Buffer match: 50" → user clicks Export → 50 000-line file; or buffer
  has zero matches because filter targets earlier-evicted traffic →
  operator abandons the export. Either re-word ("recent buffer only —
  may differ from server-side count") or add `?countOnly=true` returning
  the authoritative server-side count cheaply and show both numbers.

- [ ] **Sanitize id in `Content-Disposition`** (`monitor.controller.ts:154-156`).
  `id` is interpolated directly into the header. UUIDs are safe today;
  a future broader id scheme makes CRLF/quote injection possible.
  Defense-in-depth: `id.replace(/[^A-Za-z0-9_-]/g, '_')` before
  interpolation. Add `filename*=UTF-8''…` for non-ASCII safety.

## From PR #175 review — CrossReferenceEngine + REST endpoint

- [ ] **`Promise.allSettled` + per-dimension `dimensionUnavailable` flags**
  (`apps/api/src/monitor/cross-reference.engine.ts:669-691, 756-775`).
  Today a single storage rejection (slowlog adapter down, audit table
  missing) aborts the whole computation with a raw 500. Combined with
  the empty-baseline rule, a misconfigured adapter creates a
  false-positive flood. Switch to `allSettled`, log each rejection with
  a stable errorId, and surface
  `dimensionUnavailable: 'slowlog' | 'audit' | …` on the result so the
  UI gates regression rendering on `'ok'`.

- [ ] **DST-correct `same-hour-last-week`**
  (`cross-reference.engine.ts:277-281`). Today `sessionStartMs - WEEK_MS`
  shifts wall-clock 168h, not 7 calendar days. Spring forward / fall
  back silently drifts the window an hour for non-UTC deployments.
  Either calendar-shift via local date components (or a date library)
  or rename the window to reflect the 168h semantics and document it.

- [ ] **Bucket-based p95 with minimum-sample gating**
  (`cross-reference.engine.ts:412, 446-454`). `baselineRates` is one
  rate per distinct verb (typically 1–3 verbs) rather than per time
  bucket. With 1 verb, p95 = that verb's rate → no regression ever
  fires; with empty baseline, p95 = 0 → every nonzero session rate
  regresses. Bucket the baseline window into N intervals (e.g. 60s),
  compute p95 of per-verb-per-bucket rates, and refuse to flag
  regressions when `bucketCount < MIN_BASELINE_SAMPLES` (log
  `MONITOR_CROSSREF_INSUFFICIENT_BASELINE` and surface
  `dimensionUnavailable: 'slowlog-insufficient-samples'`).

- [ ] **Reject cross-reference on non-completed sessions** (controller +
  `cross-reference.engine.ts:109`). `session.endedAt ?? Date.now()`
  lets a `running` session compute against a sliding endpoint — two
  calls return different `newShapes` / regression sets. Either 409 in
  the controller when `session.status !== 'completed'`, or accept
  `?allowPartial=true` and stamp `session.partial: true` on the
  response.

- [ ] **`NewShape` discriminated union + hash EVAL script bodies**
  (`cross-reference.engine.ts:21-27, 286-290, 296`). Two issues:
  `{ arity: number|null; scriptSha: string|null }` allows all four
  states; replace with
  `{ kind: 'plain'; arity } | { kind: 'scripted'; cmd; scriptSha }`.
  EVAL without preload uses args[0] as the *script source*, not a SHA —
  encoding multi-line script text as the shape key explodes cardinality
  and leaks script contents into responses / log aggregators. Hash
  before use: `sha1(scriptBody).slice(0, 16)`. Also `.toLowerCase()`
  SHAs for `EVAL`/`EVALSHA` (Redis treats them case-insensitive); keep
  function names case-sensitive.

- [ ] **Look up `newInTopK` against the full key map, not the top-50
  slice** (`cross-reference.engine.ts:14, 357-362`). A key at baseline
  rank 60 → capture rank 5 currently appears in `newInTopK` (misleading
  — it WAS in baseline). A key going 49 → 51 silently vanishes from
  `rankChanges`. Look up in the full `baselineKeyCounts`; surface
  `rankInBaseline: '>50'` (or numeric rank + `wasBelowTopK: true`).
  Also add a deterministic tiebreaker to the top-K sort
  (`(a,b) => b[1]-a[1] || a[0].localeCompare(b[0])`) — V8 stable-sort
  + differing insertion order across capture/baseline produces phantom
  `rankChange` rows today.

- [ ] **Promote `aclDeltas.counters` from placeholder to discriminated
  state** (`cross-reference.engine.ts:602-614, 169-174`). Today both
  counter fields are hard-coded `null` and the spec at
  `cross-reference.engine.spec.ts:455` locks in the placeholder — so
  no test breaks when the real implementation lands. Either drop the
  field until populated, or surface
  `counters: { status: 'not-yet-implemented' }`. Also:
  `MonitorCaptureService.startSession` / `terminate` need to take
  INFO snapshots for the counter deltas to be implementable.

## From PR #176 review — cross-reference panel + baseline selector

- [ ] **Don't cache cross-reference results for `running` sessions**
  (`apps/web/src/pages/monitor/cross-reference-panel.tsx:128-132`).
  QueryKey is `['monitor', 'cross-reference', sessionId, baseline]` — no
  status. A user opens a still-running session, the panel computes against
  in-progress capture and caches forever; the status flips
  `running → completed` via parent polling but the cross-reference never
  refetches. Either disable the query while `status === 'running'`, or
  include `status` in the queryKey, or invalidate from the parent on
  status transition.

- [ ] **Distinguish per-section "empty" from "unavailable"**
  (`cross-reference-panel.tsx:230-232, 251-253, 307-311`). Today empty
  arrays from the backend (broken slowlog poller, empty audit table,
  zero baseline rows) render as `"No hot-key shifts"` /
  `"every captured command was seen in baseline"` — green checkmarks on
  a broken backend. Pairs with the #175 `dimensionUnavailable` follow-up:
  once that lands, branch the empty-state copy. Until then, surface
  coverage caveats from `result.session.capturedLineCount === 0` and
  `baseline.rowCount === 0` distinctly.

- [ ] **Truncate EVAL script bodies in `NewShapesList`**
  (`cross-reference-panel.tsx:235-247`). Per #175, `EVAL` without preload
  encodes raw Lua source as the shape string. The component renders it
  in a `<span>` with no `truncate` / `break-all` / `max-width` — blows
  out the column. Wrap with `truncate` + `title={s.shape}` tooltip;
  special-case `cmd === 'EVAL' && scriptSha === null` to render
  `EVAL (inline script)` instead of the body.

- [ ] **Move `CrossReferenceResult` types to `packages/shared`**
  (`apps/web/src/api/monitor.ts:36-53`). The mirror has **already drifted**
  vs the backend: frontend declares `baseline.window: BaselineWindow`
  while backend `cross-reference.engine.ts:71` is
  `BaselineWindow | CaptureBaselineMarker` and adds an optional
  `sessionId`. Future renames silently render `undefined` and any
  `.toFixed` / `.toLocaleString` calls throw at runtime. Either re-export
  from `@betterdb/shared` (and import on both ends) or add a Zod parse
  at the `fetchApi` boundary.

- [ ] **Filter or dim `(redacted)` rows in the hot-key list**
  (`cross-reference-panel.tsx:262-269`). Author flagged. `(redacted)` is
  a MONITOR marker, not a key — rendering "(redacted) ×3 (rank #2)" as
  a top hot-key is misleading. Either filter from the list and group
  into a `"+N redacted entries"` footnote, or render the row with
  `text-muted-foreground` + an explanatory tooltip.

- [ ] **Disambiguate `aclDeltas.counters` `null` from `0` visually**
  (`cross-reference-panel.tsx:333-337`). Both render in the same
  `font-mono` style and color. The disambiguation footer at `:339-343`
  only appears when BOTH counters are null — a mixed state (one `null`,
  one `5`) shows `—` next to a real number with no explanation, and an
  operator reads `—` as "no breaches." Mute/italicize the `—` glyph and
  attach a per-row tooltip explaining "pending session-boundary
  snapshot," regardless of the sibling.

## From PR #177 review — cluster per-node selector (14a of 14)

- [ ] **Distinguish "single-instance" from "discovery failed" in
  `/connections/:id/nodes`** (`apps/api/src/monitor/monitor.controller.ts:371-375`).
  Bare `catch {}` maps every cluster-discovery failure (ACL-denied,
  network timeout, parser bug) to the same `{isCluster:false}` payload as
  a genuine single Valkey. `ClusterDiscoveryService.discoverNodes` already
  logs and re-throws — the controller erases the signal. Add a positive
  `isClusterConnection(id)` predicate on the service, return
  `{isCluster:'unknown', reason}` on real failures, log via
  `logError` with a stable errorId so a misconfigured cluster doesn't
  silently regress to MONITOR-on-arbitrary-node.

- [ ] **Don't persist `targetNodeId` as `target_node` when address
  resolution fails** (`apps/api/src/monitor/monitor-capture.service.ts:286-305`).
  The catch returns the raw cluster-discovery id (40-char hex) which is
  then written to `capture_sessions.target_node` — a column documented as
  "host:port string". No marker that the value is degraded. Either
  fail-fast (throw a typed error, roll back the session row) or skip
  persisting `targetNode` until resolution succeeds.

- [ ] **Backfill / disambiguate historical `target_node = NULL` rows**.
  Pre-PR cluster captures ran MONITOR on whatever node iovalkey routed
  to. After migration all of those rows have `target_node IS NULL` —
  indistinguishable in the UI from "single-instance capture." Operators
  reviewing last month's captures can't tell which were valid. Add a
  `target_node_status` enum (`pre-cluster-aware | single-instance |
  targeted | fanout`), backfill pre-migration rows on cluster
  connections to `pre-cluster-aware`, and surface the state in the UI.

- [ ] **Add round-trip + Postgres coverage for `target_node`**
  (`apps/api/src/storage/adapters/__tests__/capture-sessions.spec.ts`).
  Today the round-trip test never sets `targetNode`; the
  `toEqual(session)` assertion passes only because both sides are
  `undefined`. Postgres adapter is still missing from `describe.each`
  (carried over from #167), so the new column, ALTER migration, `$16`
  bind, and `mapRow` decoding are entirely unexercised. Extend the spec
  + bring postgres into the matrix.

- [ ] **Validate `targetNodeId` on POST and surface "node removed"
  specifically** (`monitor.controller.ts:108-124`,
  `monitor-capture.service.ts:292-305`). Any string is accepted; stale
  modal (node removed between open and submit) records
  `target_node = 'lost-node'` and the generic "Failed to open MONITOR"
  error fires later. Reject unknown ids with a typed
  `BadRequestException`; map `NodeNotFoundError` to a `409` with
  `{code: 'target-node-not-found', nodeId, availableNodes}` so the
  modal can refresh the dropdown.

- [ ] **Default-master selection in the modal must prefer healthy nodes**
  (`apps/web/src/pages/monitor/start-session-modal.tsx:636`). Today's
  `find(n => n.role === 'master') ?? clusterNodes[0]` pre-selects the
  first master regardless of `healthy`. During failover the unhealthy
  master is auto-selected and the user clicks Start before noticing the
  `(unhealthy)` label. Use
  `find(n => n.role === 'master' && n.healthy) ?? find(n => n.healthy) ?? [0]`,
  and render a banner if zero masters are healthy.

- [ ] **Surface `nodesQuery` errors in the start-session modal**
  (`start-session-modal.tsx:621-626`). `useQuery`'s `error`/`isError`
  return is never read. A 500 from `/connections/:id/nodes` silently
  falls through with `isCluster=false`. Render a destructive banner on
  `isError` ("Couldn't load cluster topology — capture may target an
  arbitrary node") and gate the dropdown's absence on the server's
  authoritative `isCluster` field rather than `clusterNodes.length > 0`.

- [ ] **Safer schema migrations on multi-replica Postgres**
  (`apps/api/src/storage/adapters/postgres.adapter.ts:1638-1647`).
  Concurrent `ADD COLUMN IF NOT EXISTS` from two booting replicas can
  race; the loser crash-loops on `42701`. Wrap the ALTER block in a
  try/catch that swallows `42701` specifically (or take a Postgres
  advisory lock), and replace the bare-catch in the sqlite migration
  helper (`sqlite.adapter.ts:459-467`) with a code-specific guard that
  still logs unrelated errors.

## From PR #178 review — cluster fan-out + partial-failure (14b of 14)

- [ ] **Recover orphaned fan-out sessions on startup**
  (`apps/api/src/monitor/monitor-capture.service.ts:435-457`). Fan-out
  writers use `skipSessionFinalize: true`; only `finalizeFanOutSession`
  writes the terminal row, with all aggregation state in process
  memory. An API crash between `saveCaptureSession` and the finalize
  call leaves the session row `running` forever. Add a startup
  reconciler that flips orphan `running` sessions older than 2× their
  `durationMs` to `failed` with `terminationReason='orchestrator_crash'`
  (or have writers persist per-node terminal segments so any survivor
  can finalize). Pairs with the #167 finalize-zombie follow-up.

- [ ] **Don't dispatch `sessionEnded` when `finalizeFanOutSession`'s
  storage write fails** (`monitor-capture.service.ts:489-500`). Today
  `try { update } catch { logger.error }` then still emits the webhook —
  consumers see a "completed" event while the DB row is stuck on
  `running`. Retry with bounded backoff; on persistent failure log via
  `logError` with a stable errorId, skip the dispatch, and enqueue for
  the recovery sweep above.

- [ ] **Distinguish "discovery failed" from "not a cluster" in
  `resolveFanOutNodes`** (`monitor-capture.service.ts:567-581`). Today
  `try { discover } catch { return [] }` silently degrades to single-node
  when the user explicitly checked the "Fan-out" box. Return a typed
  result (e.g. `{ kind: 'not-cluster' } | { kind: 'discovery-failed';
  error } | { kind: 'nodes'; nodes }`) and surface a 503 / typed error
  back to the modal so the user can retry. Also: return 503 when
  `fanOut` was requested but zero primaries are healthy, and surface
  `excludedNodes` when a subset is unhealthy (today: silently dropped
  from the fan-out).

- [ ] **Enforce the 10M chunk-index namespace in `CaptureWriter`**
  (`apps/api/src/monitor/capture-writer.ts:139`,
  `monitor-capture.service.ts:57,285`). Today the per-writer range
  `[i*10M, (i+1)*10M)` is documented but never asserted. A writer that
  overruns silently corrupts per-node attribution (next writer's
  namespace). Either `terminate('truncated', 'chunk_namespace_exhausted')`
  when `chunkIndex >= startChunkIndex + CHUNK_INDEX_NAMESPACE`, or
  replace the namespace trick with an explicit `node_id` column on the
  PK (the column already exists from this PR). Export
  `CHUNK_INDEX_NAMESPACE` from a shared module so writer + service
  can't drift.

- [ ] **Discriminated single-node-vs-fan-out for `StoredCaptureSession`**
  (`packages/shared/src/types/monitor.ts:10`). Today `{ targetNode?,
  nodeSegments? }` permits both set and neither set with the fan-out
  flag. Convert to:
  ```ts
  type StoredCaptureSession = Base & (
    | { kind: 'single'; targetNode?: string; nodeSegments?: never }
    | { kind: 'fanOut'; nodeSegments: CaptureNodeSegment[]; targetNode?: never }
  );
  ```
  Eliminates the `nodeSegments?.length ?? 0 > 0` checks in UI / service
  / migration code and is the natural home for the recovery sweep
  predicate.

- [ ] **`aggregateSegmentStatus([])` should return `'failed'`, not
  `'completed'`** (`monitor-capture.service.ts:589`). For a fan-out
  session, empty segments means zero writers opened — a bug, not a
  success. Either narrow input to `NonEmptyArray<>` or return
  `{ status: 'failed', reason: 'no_nodes_resolved' }`. Today the path
  is gated by `isFanOut = fanOutNodes.length > 0` but the function's
  invariant is still wrong on its face.

- [ ] **Validate `nodeSegments` JSON on adapter read with Zod**
  (`apps/api/src/storage/adapters/sqlite.adapter.ts:893-902`,
  `postgres.adapter.ts:752-763`). Today both adapters do
  `try { JSON.parse } catch { return undefined }` with zero logging and
  only `Array.isArray` validation. A bad row (older schema, partial
  write, manual SQL) flows through as `CaptureNodeSegment[]` and crashes
  `.lineCount.toLocaleString()` in the UI session-list. Add a shared
  Zod schema in `packages/shared`, parse on read, log invalid rows via
  `logError`.

- [ ] **Surface all fan-out writers (or label the visible one) from
  `getActiveWriter`** (`monitor-capture.service.ts:451-454`). Today
  returns `writers[0]` only — the tail UI silently shows one node's
  lines. Either return `getActiveWriters()` and let the tail page
  interleave (or paginate by node), or set an
  `X-Monitor-Tail-Node: <nodeId>` header so the UI can render
  "Showing node A of A, B, C." Author flagged.

- [ ] **Deadline + timeout on `stopSession` for fan-out**
  (`monitor-capture.service.ts:438-447`). `await active.donePromise`
  resolves only when every writer's `Promise.all` settles — one writer
  with a hung network connection blocks `stopSession` forever and the
  HTTP request times out. Race against a 30s deadline; on timeout, mark
  unresolved segments `failed` with reason `stop_timeout` and proceed to
  finalize.

- [ ] **`CaptureNodeSegment.status` should narrow to `CaptureWriterStatus`**
  (`packages/shared/src/types/monitor.ts`). Today reuses
  `CaptureSessionStatus` (5 variants) but only 3 are meaningful for a
  terminated segment (`'completed' | 'truncated' | 'failed'`).
  `'skipped'` and `'running'` are nonsensical post-hoc and silently
  permit illegal aggregator inputs. Reuse `CaptureWriterStatus` —
  exhaustiveness is provable.

- [ ] **Postgres adapter coverage for `node_segments` + `node_id`**
  (`apps/api/src/storage/adapters/__tests__/capture-sessions.spec.ts`).
  Same gap as #177's `target_node` — `describe.each` covers only
  Sqlite + Memory. Now there's a JSONB column to test (parser, partial
  patch via `updateCaptureSession`, round-trip). Extend the matrix.

## From PR #179 review — Pro+ capture triggers + REST + license gate

- [ ] **Remove `MONITOR_DEV_PREVIEW` gate from `CaptureTriggerRegistry.onModuleInit`**
  (`apps/api/src/monitor/capture-trigger-registry.ts:639-651`). Commit
  `9cee378` removed the gate elsewhere but this file was missed. Today
  the Pro+ feature accepts trigger creation in production but **never
  polls** — operators see `201 {status:'configured'}`, no fire, then
  `expired` 24h later, with no log.

- [ ] **Atomic, status-guarded state transitions in storage**
  (`updateCaptureTrigger` across sqlite / postgres / memory).
  - Replace blind status patches with
    `UPDATE … WHERE id = ? AND status IN (<expected>)` (or a
    `compareAndSetStatus(id, expected, next)` storage primitive). Rejects
    `cancelled → fired` and similar at the DB.
  - Add a partial unique index on
    `(connection_id, metric_type, anomaly_type) WHERE status IN ('configured','queued')`
    so concurrent `createTrigger` calls can't race past
    `findActiveTrigger`.
  - These two changes also close the **multi-replica double-fire**: two
    pods both pass `findActiveTrigger`, both call `startSession`. An
    atomic claim (`UPDATE … SET status='fired' WHERE id = ? AND status='configured'`)
    serialises the claim.

- [ ] **Per-step + per-trigger try/catch in `tick()`**
  (`capture-trigger-registry.ts:712-724, 798`). Today `sweepExpired`,
  `processQueued`, `processNewAnomalies` run sequentially with no
  per-phase catch; one rejected storage call or `HealthGateService.evaluate`
  throw aborts the entire tick. Wrap each phase and each per-trigger
  iteration; on health-gate failure mark the trigger `skipped` with
  `skipReason: 'health_gate_error: <msg>'` (distinguishes from
  signal-gated skip).

- [ ] **Typed `CaptureBusyException` instead of string-match**
  (`capture-trigger-registry.ts:823-834`). `message.includes('already
  active')` decides between busy → `queued` and generic error →
  `skipped`. Locale change / refactor of the error text silently flips
  every contention into a one-shot failure. Throw a typed exception
  from `MonitorCaptureService.startSession` and `instanceof`-check.

- [ ] **Discriminated `StoredCaptureTrigger` by status**
  (`packages/shared/src/types/monitor.ts:62`). Today's flat shape lets
  a `cancelled` trigger appear to have a `firedSessionId`, and lets
  `{status:'fired'}` be constructed without one. Convert to:
  ```ts
  type StoredCaptureTrigger =
    | { status: 'configured' | 'queued'; …base }
    | { status: 'fired';    firedAt: number; firedSessionId: string }
    | { status: 'skipped';  skipReason: string }
    | { status: 'expired' | 'cancelled' };
  ```
  Pairs naturally with the storage-layer transition guards above.

- [ ] **`firedSessionId` should reflect terminal session status**
  (`capture-trigger-registry.ts:818-822`). Trigger flips to `fired` the
  instant `startSession` resolves. If the session later fails
  (capture-writer error, MONITOR-open fail, node disconnect), the
  trigger row stays `fired` pointing at a `failed` session. Either add
  a terminal `fired_failed` state populated when `MonitorCaptureService`
  finalises a failed session that has a `triggerId`, or join against
  `capture_sessions.status` in the `/monitor/triggers` response shape.

- [ ] **License-gate + DemoMode coverage at controller level**.
  - Controller spec instantiates `MonitorController` directly,
    bypassing the Nest pipeline → `@UseGuards(LicenseGuard)` +
    `@RequiresFeature(MONITOR_ANOMALY_TRIGGER)` on the three trigger
    endpoints are never exercised. Use `Test.createTestingModule` and
    assert 402/403 on community-tier license.
  - `proprietary/cloud-auth/demo-mode.guard.spec.ts` has zero references
    to `/monitor/triggers`. Add POST/DELETE → 403 + GET → 200 on demo
    host. Also anchor the prefix match (`p === path || path.startsWith(p
    + '/')`) — same #168/#177 follow-up.

- [ ] **Pre-load active triggers once per tick**
  (`capture-trigger-registry.ts:785-789`). `findActiveTrigger` runs 2
  storage queries **per anomaly event** inside the per-event loop. With
  `maxPerTick = 5000` that's up to 10 000 SELECTs per tick. Fetch
  configured+queued triggers once at top of `processNewAnomalies`, then
  match in-memory.

- [ ] **Validate `metricType` and `anomalyType` against canonical
  anomaly enums** at the create-DTO boundary
  (`apps/api/src/monitor/monitor.controller.ts` create handler). Today a
  typo (`'connetions'` for `'connections'`) silently never matches; the
  trigger sits `configured` → `expired` after 24h. Reject unknown values
  with `BadRequestException` listing the valid set.

- [ ] **`MONITOR_TRIGGER_POLL_MS` as Zod-validated env var**
  (`capture-trigger-registry.ts:576`). Today `DEFAULT_POLL_INTERVAL_MS =
  5_000` is hard-coded; only the test seam can override. Same #165/#169
  pattern — add `z.coerce.number().int().min(100).default(5000)` to
  `env.schema.ts`, inject `ConfigService`. Also: when `setInterval`
  fires and `ticking` is true (i.e. previous tick still running), log a
  warning so silent throttling is visible.

## From PR #181 review — trigger.created + session.skipped webhooks

- [ ] **Switch webhook-dispatch error logging to `logError` + errorId**
  (`apps/api/src/monitor/capture-trigger-registry.ts:331-333, 353-355`).
  Today `this.logger.error(\`… ${(err as Error).message}\`)` writes to
  stdout only — Sentry never sees dispatch failures. Also `.message`
  swallows non-Error rejections (`undefined` in the log) and drops the
  stack. Define `MONITOR_TRIGGER_WEBHOOK_DISPATCH_FAILED` /
  `MONITOR_SESSION_SKIPPED_WEBHOOK_DISPATCH_FAILED` errorIds and pass
  `{ triggerId, connectionId, eventType, cause: err }`.

- [ ] **Rename `monitor.session.skipped` → `monitor.trigger.skipped`**
  (`packages/shared/src/webhooks/types.ts`). The event fires from
  `tryFire` when the gate denies — **no session was ever started**. The
  current name implies a session entity existed; SIEM dashboards keyed
  on `session.*` vs `trigger.*` namespaces will miscategorise. Cheap to
  fix pre-launch, breaking change later. Pairs with the missing
  lifecycle-events item below.

- [ ] **Promote `monitor.trigger.skipped` to Pro tier** (`types.ts:88`).
  Today community-tier; only Pro triggers produce it, so a community
  subscriber receives zero events and assumes the webhook is broken.
  Tier should match the producing feature.

- [ ] **Add the missing trigger lifecycle events**: `monitor.trigger.fired`
  (mandatory — pairs with `trigger.skipped`), plus `monitor.trigger.cancelled`
  and `monitor.trigger.expired`. Without these, subscribers who keyed
  off `monitor.trigger.created` to provision resources never learn the
  trigger terminated. `trigger.expired` also addresses the #179 finding
  about silent expiry-without-firing.

- [ ] **Dispatch the `start_failed` skip path or document the gap**
  (`capture-trigger-registry.ts:276-279`). Today the `start_failed: <msg>`
  branch flips the trigger to `skipped` but never calls
  `dispatchSessionSkipped`. Subscribers see successful starts silently
  fail. Either dispatch (with `reason: 'start_failed'`) or document the
  contract with a negative test.

- [ ] **Derive `createdBy` from the authenticated principal, not the
  request body** (`monitor.controller.ts:337` → `capture-trigger-registry.ts:313`).
  Same #168 finding (`requestedBy`) carried over: today any caller can
  put any string into the webhook audit trail. Strip from DTO, read
  from `@User()` decorator.

- [ ] **Fix the create-then-cancel race in `dispatchTriggerCreated`**
  (`capture-trigger-registry.ts:131`). `void` makes dispatch a microtask
  scheduled after `saveCaptureTrigger`. A `cancelTrigger` (or expiry
  sweep) between save and dispatch results in `trigger.created` being
  sent for an already-cancelled trigger. Re-read trigger status inside
  the dispatch helper and skip if not `configured`.

- [ ] **Validate `skipped.reason` against an allowlist; distinguish
  `health_gate_blocked` from `health_gate_unavailable`**
  (`capture-trigger-registry.ts:247, 344`). Today
  `gate.skipReason ?? 'health_gate_blocked'` accepts any string and
  swallows the case where the gate threw (per #165 follow-up). Validate
  against `HealthGateSkipReason | 'unknown' | 'health_gate_unavailable'`
  before dispatch; on unknown values, log via `logError` and send
  `reason: 'unknown'`.

- [ ] **`packages/shared/src/webhooks/types.spec.ts` parity test for
  `FREE_EVENTS`/`PRO_EVENTS`/`WEBHOOK_EVENT_TIERS`**. The three
  structures are parallel and silently drift (the Record is exhaustive
  at compile time but the arrays aren't). Pairs with the #169 follow-up
  that proposed deriving the arrays from the tier map. Either derive,
  or pin parity in a spec.

## From PR #182 review — Triggers tab UI

- [ ] **Add error handling to `handleCancelTrigger`** (`apps/web/src/pages/Monitor.tsx:35-43, 80-86`).
  Today `try { … } finally { … }` with no catch swallows 404 (already
  cancelled/expired), 402 (license downgrade), 500, network failure.
  User sees "Cancelling…" flip back to "Delete," same silent no-op on
  retry. Add a `catch`, route `PaymentRequiredError` through
  `useUpgradePrompt`, toast the rest, and `logError` with a stable
  errorId.

- [ ] **Tear down the triggers query and redirect the tab on license
  downgrade** (`Monitor.tsx:39-45`). When `hasFeature` flips
  Pro → Community mid-session, the polling query already in flight keeps
  hitting `/monitor/triggers` and routing 402s into `showUpgradePrompt`
  every 5 s — spamming the upgrade modal. The user can also be stranded
  on a blank `triggers` tab (`defaultValue="sessions"` doesn't auto
  switch). On `!triggersEnabled`, call
  `queryClient.removeQueries({ queryKey: triggersKey })` and force the
  tab back to `sessions` via an effect.

- [ ] **Surface `triggersQuery.error` as a banner**. The page
  destructures `data`/`loading` only and the empty state ("No capture
  triggers configured") swallows persistent 500s. Same #171 finding —
  worth fixing across both pages at once.

- [ ] **Defensive formatters for triggers-table**
  (`apps/web/src/pages/monitor/triggers-table.tsx:35-66, 141-154`).
  - `formatRelative` renders literal `"NaN d"` for missing /
    garbage `expiresAt`: `NaN <= 0` is `false` so the `'expired'`
    short-circuit misses, then every threshold branch is `false` →
    `${NaN.toFixed(1)}d`. Add `if (!Number.isFinite(ms)) return '—';`
    at the top.
  - `formatTimestamp(undefined)` renders `"Invalid Date"`. Guard to
    return `"—"` on non-finite / null input.
  - Extract both to `apps/web/src/lib/format-time.ts` alongside the
    similar functions duplicated from #171's sessions-table.

- [ ] **`EVENT_LABELS[type] ?? type` fallback in WebhookForm**
  (`apps/web/src/components/webhooks/WebhookForm.tsx:71-72`). Today
  `Record<WebhookEventType, string>` is exhaustive at compile time, but
  the #181 follow-up will rename `monitor.session.skipped` →
  `monitor.trigger.skipped`. After the rename, the lookup falls to
  `undefined` and the dropdown shows a blank label silently. Defaulting
  to the raw event name keeps the form usable through the rename.

- [ ] **Status-badge unknown-status visibility**
  (`triggers-table.tsx:107-121`). Today an unmapped status falls through
  to `'outline'` with the raw enum string — graceful, but the operator
  has no signal the UI is out-of-date with backend. Make it an
  exhaustive switch with a `never` check (compile-time), and `logError`
  once per session on unknown status so version skew surfaces in
  Sentry.

- [ ] **Optimistic remove + global cancel-in-flight disable**
  (`triggers-table.tsx:69`). `disabled={cancellingId === t.id}` disables
  only the single row. Same-row double-click can race the state commit;
  more importantly the row stays visible until the next 5 s poll, so a
  user "double-deletes" by clicking again before the list refreshes
  (404 silent — see error-handling item above). Optimistically remove
  the row from the cache on cancel, or disable cancel across the entire
  list while any cancel is in flight.

- [ ] **URL state for the Sessions/Triggers tab** (`Monitor.tsx:88`).
  Today `defaultValue="sessions"` is fixed — no `useSearchParams`, no
  deep-link to `?tab=triggers`. That defeats the point of the new
  `monitor.trigger.created` webhook (operators clicking the alert link
  always land on Sessions). Sync the active tab with the URL.

- [ ] **`firedSessionId` should link to the captured session**
  (`triggers-table.tsx:73-75`). Today the column shows `slice(0, 8)`
  with no affordance. Wrap with `<Link to={\`/monitor/sessions/${t.firedSessionId}\`}>`.

- [ ] **Tests for the license gate, status-variant matrix, formatter
  guards, and cancel mutation flow**. None added in this PR. Infra is
  fully present (`apps/web/vitest.config.ts` + `useLicense.test.ts` /
  `formatters.test.ts` / `commandstats.test.ts` /
  `PendingCard.test.tsx` precedents). Minimum: license gate visible
  vs hidden + polling-disabled-when-ungated; each of the 6 status
  variants; cancel → invalidates; cancel rejection → no invalidation
  + button re-enables; `formatRelative` boundary table (0, 59999, 60000,
  1h, 1d, `NaN`, negative).

## From PR #183 review — Capture-on-next row action + prefilled modal

- [ ] **Drop `VITE_MONITOR_DEV_PREVIEW` from `captureActionEnabled`**
  (`apps/web/src/pages/AnomalyDashboard.tsx:130, 134-137`). PR adds a
  fresh `MONITOR_DEV_PREVIEW` literal and ANDs it into the row-action
  gate. The launch commit `9cee378` removes the env var everywhere
  else, so post-launch the gate evaluates `false` for everyone — feature
  ships dark for all licenses. Gate solely on
  `hasFeature(Feature.MONITOR_ANOMALY_TRIGGER) && !!currentConnection?.id`.

- [ ] **Fix wrong-connection trigger creation on connection switch**
  (`AnomalyDashboard.tsx:55-70`, `capture-on-next-modal.tsx:48-58`).
  `openCaptureModal` snapshots `currentConnection.id` into modal
  context at click time. If the user changes connection via the global
  selector while the modal is open, Confirm submits with the OLD
  `connectionId` in the body but the NEW one in the
  `X-Connection-Id` header. Either auto-close the modal on connection
  change (`useEffect` watching `currentConnection?.id` calls
  `onOpenChange(false)`), or re-read inside `handleConfirm` and abort
  with a clear message.

- [ ] **Branch error UX in the modal**
  (`capture-on-next-modal.tsx:56-58`). Today raw `err.message` is shown
  for every failure: 402 (license downgrade — `PaymentRequiredError`
  bypasses the `hasFeature` gate once the modal is mounted), 409 dedup
  (#179 — the common repeat-click case), 400 (per the upcoming canonical
  enum validation), 500. Add typed branches:
  `PaymentRequiredError` → upgrade CTA; 409 → "trigger already armed
  for this metric + anomaly — view in Triggers" with a link to
  `/monitor?tab=triggers`; 500 → retry hint. Also call
  `logError('monitor.anomaly.capture_on_next_failed', err, { connectionId, metricType, anomalyType, source })`
  before setting the user-facing message — today the catch logs
  nothing, leaving zero Sentry signal for "Capture next failed."

- [ ] **Surface success via a toast with a "View triggers" action**
  (`capture-on-next-modal.tsx:53-57`). Today the only success signal is
  the green banner inside the modal; once the user clicks Close the
  `/anomalies` page is visually unchanged and the "Capture next" row
  button still shows — they reasonably doubt the action and either
  navigate to `/monitor` to verify or double-click (→ 409 silent, see
  the error-branching item). The whole point of the row-action UX was
  to make that round-trip unnecessary.

- [ ] **Move `CaptureOnNextModal` to `components/pages/anomaly-dashboard/`**
  (`apps/web/src/pages/anomalies/capture-on-next-modal.tsx`). Same
  CLAUDE.md convention violation as #171/#172/#176 and the monitor
  pages — track under the existing follow-up but the new
  `pages/anomalies/` directory is yet another spot to consolidate.

- [ ] **Prefix-based invalidation for the triggers query**
  (`capture-on-next-modal.tsx:56`). Today
  `queryClient.invalidateQueries({ queryKey: ['monitor', 'triggers', context.connectionId] })`
  matches the canonical key in `apps/web/src/pages/Monitor.tsx:31` —
  but the moment the Monitor.tsx key grows a filter (`{status}`,
  pagination, etc.) invalidation silently misses and the Triggers tab
  shows stale data. Use prefix invalidation
  (`{ queryKey: ['monitor', 'triggers'], exact: false }`), and
  centralise the key shape in a shared `monitorKeys` factory imported
  by both files.

- [ ] **Disambiguate "Capture next" on group rows**
  (`AnomalyDashboard.tsx:443-449`). The button inside an expanded
  correlated group calls `openCaptureModal(anomaly, 'group')` with a
  single per-event anomaly. Operators reasonably expect "capture the
  whole group" but the modal arms only one metric. Either move the
  action to the group header (capture-on-any-member) or rename to
  "Capture next on this metric" so the scope is obvious.

- [ ] **Address residual eslint hygiene in `AnomalyDashboard.tsx`**
  (`:195, 228, 229, 233, 200`). The PR cleaned several issues but
  retained `// Time filter…`, `// fallback: 24 h`, `// 60 buckets`, a
  `parseInt(a)` without radix, and a fresh
  `// eslint-disable-next-line react-hooks/purity` around `Date.now()`.
  CLAUDE.md says fix existing eslint errors when editing a file rather
  than `disable`-commenting. Solve the purity warning by lifting
  `now` out of the memo (e.g. stable from polling); drop the
  freeform comments per the no-comments rule.

- [ ] **Test the modal**: payload integrity (single
  `monitorApi.createTrigger` call with exact
  `{connectionId, metricType, anomalyType}` from row context),
  invalidation key, dual-gate visibility (`hasFeature` + license
  downgrade + missing connection), state-reset on close (including
  reopen with different context), 409 error path, prefill correctness
  (event vs group rows). Infra fully present (`PendingCard.test.tsx`
  precedent).

## From PR #184 review — scheduled captures + CaptureScheduler + REST

- [ ] **Remove `MONITOR_DEV_PREVIEW` gate from `CaptureScheduler.onModuleInit`**
  (`apps/api/src/monitor/capture-scheduler.ts:515`). Same #179 finding,
  same shape: production restart → schedules persist in storage but
  never re-register; no fires, no log. Pro+ feature ships dark.
  License gate is the correct security boundary; drop the env check.

- [ ] **Atomic claim / single-leader for ticks on multi-replica**
  (`capture-scheduler.ts:583-594`). Every replica registers per-row
  `setInterval`. A 3-pod deployment fires each schedule 3× per
  interval; the second/third races against an in-process
  `hasActiveSessionOn` check that doesn't cross processes. Add a
  DB-level atomic claim (`UPDATE scheduled_captures SET last_fired_at
  = ? WHERE id = ? AND (last_fired_at IS NULL OR last_fired_at <
  ? - interval_seconds*1000)`) before `startSession`, or gate the
  scheduler to a single leader (advisory lock / role flag). Pairs with
  the #179 follow-up.

- [ ] **`lastSkipReason: undefined` doesn't actually clear the column**
  (`capture-scheduler.ts:638-642`,
  `apps/api/src/storage/adapters/postgres.adapter.ts:969-972`,
  `sqlite.adapter.ts:1136-1139`). Success path writes
  `lastSkipReason: undefined`; adapters guard with
  `patch.lastSkipReason !== undefined` and drop the field. A healthy
  schedule that just recovered from `memory_above_threshold` displays
  the stale reason indefinitely. Use a `null` sentinel that adapters
  translate to a real `NULL`, or always write the column.

- [ ] **Per-row try/catch in `onModuleInit` restore**
  (`capture-scheduler.ts:518-522`). One row's `addInterval` throw
  aborts the loop; rows after N never restore; Nest crash-loops the
  pod; no `lastSkipReason: 'restore_failed: <msg>'` is persisted. Wrap
  each iteration in try/catch, log per-row with an errorId, mark the
  bad row, continue.

- [ ] **Decide on `cronExpression`** — implement or remove from the
  shared types (`packages/shared/src/types/monitor.ts:98, 118`). The
  field is in `StoredScheduledCapture` and `ScheduledCapturePatch` but
  the scheduler completely ignores it (`capture-scheduler.ts:583-594`
  only uses `intervalSeconds * 1000`). A future PATCH that toggles to
  cron form would persist a row the scheduler can't fire
  (`setInterval(undefined)`). Either drop the field for now or land a
  discriminated `ScheduleSpec = { kind: 'interval' } | { kind: 'cron' }`.

- [ ] **Add `CaptureScheduler.updateSchedule(id, patch)` and make
  `StoragePort.updateScheduledCapture` `@internal`**
  (`capture-scheduler.ts`, `apps/api/src/common/interfaces/storage-port.interface.ts:494-499`).
  Today `ScheduledCapturePatch` allows mutating `intervalSeconds` but
  no scheduler method re-registers the timer. The first PATCH endpoint
  to land silently desyncs the timer map from storage. Route mutations
  through the scheduler; rename / mark the raw storage method so other
  modules can't bypass.

- [ ] **`fireOnce` exposed as a public method** (`capture-scheduler.ts:575`).
  Documented as a test seam but reachable from any in-process
  collaborator — and a future controller could expose it, bypassing
  the license gate (which lives on the controller, not the
  scheduler). Mark `@internal`, prefix `_`, or move behind a test-only
  subclass / DI override.

- [ ] **Sanitize / redact errors persisted to `lastSkipReason`**
  (`capture-scheduler.ts:644-648`). `(err as Error).message` may
  include connection strings, IPs, internal hostnames, and is exposed
  by `GET /monitor/schedules` to anyone with the feature flag. There's
  also no `logError` / Sentry errorId. Store an opaque code
  (`start_failed`) plus a separate redacted detail; route full
  detail through `logError` with a stable errorId.

- [ ] **Cross-field validation: `intervalSeconds * 1000 > durationMs +
  headroom`** (`capture-scheduler.ts:657-676`). `{ intervalSeconds:
  10, durationMs: 900_000 }` passes individual bounds (≥10s, ≤15min)
  but produces a schedule that perpetually skips itself via
  `hasActiveSessionOn`. Reject the combo at create time. Same place
  should reject non-integer `intervalSeconds` / `durationMs` — today
  floats are silently truncated by Sqlite and rejected by Postgres,
  yielding inconsistent backend behavior.

- [ ] **Discriminated `lastOutcome` union for schedule + trigger rows**
  (`packages/shared/src/types/monitor.ts`). `lastFiredAt` /
  `lastFiredSessionId` / `lastSkipReason` (schedules) and
  `firedAt` / `firedSessionId` / `skipReason` (triggers) each encode
  three mutually-exclusive states as three independent optionals. Add
  a shared discriminated `LastOutcome = { kind: 'fired'; at;
  sessionId } | { kind: 'skipped'; at; reason } | { kind: 'never' }`
  and unify naming between the two record types.

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
