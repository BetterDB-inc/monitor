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
