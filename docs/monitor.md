---
title: MONITOR Capture Sessions
nav_order: 9
---

# MONITOR Capture Sessions

On-demand command capture for Valkey and Redis. MONITOR opens a dedicated
connection to the target instance, streams every command in real time,
and persists the result as a *capture session* you can replay, filter,
diff, and export.

## Quick start

1. Open `/monitor` in the BetterDB UI.
2. Click **Start session** → review the pre-flight panel (provider
   warnings, ACL, throughput estimate) → confirm the duration and caps.
3. The session opens with a live tail. The capture writes to disk in the
   background; close the tab and come back any time — the session keeps
   running until the duration cap, byte cap, line cap, or a manual stop.
4. When the session finishes, the detail page surfaces filters, export
   (JSON / CSV), a four-axis cross-reference against connection history,
   and (Pro+) a capture-vs-capture diff.

## Tiers and feature gating

| Capability | Community | Pro | Enterprise |
| --- | :---: | :---: | :---: |
| Manual capture sessions, live tail, filters, export | ✓ | ✓ | ✓ |
| Cross-reference vs connection history | ✓ | ✓ | ✓ |
| `monitor.session.*` webhooks (`started` / `completed` / `truncated` / `skipped`) | ✓ | ✓ | ✓ |
| Anomaly-triggered captures (`/monitor/triggers`) | — | ✓ | ✓ |
| `monitor.trigger.created` webhook | — | ✓ | ✓ |
| Scheduled captures, interval + cron (`/monitor/schedules`) | — | ✓ | ✓ |
| Capture-vs-capture diff | — | ✓ | ✓ |

Pro+ tabs and row actions are hidden for Community-tier licenses; the
underlying API endpoints return `402` for the same requests.

## Pre-flight panel

The start modal computes a server-side pre-flight before the capture
opens. Surface findings:

- **Provider banner** — managed providers (ElastiCache, Memorystore,
  Redis Cloud, Upstash) get an amber banner with provider-specific
  restrictions and a link to the vendor's restricted-commands docs. Self-
  hosted instances stay quiet.
- **ACL banner** — when the connection user is missing `+monitor`, an
  `ACL SETUSER` snippet is rendered with a copy-to-clipboard button.
- **Health gate** — memory pressure, recent OOM events, replication lag,
  and active failover. The gate only blocks anomaly-triggered and
  scheduled captures; manual sessions surface the report as a warning.
- **Throughput estimate** — projected lines and bytes for the requested
  duration based on the live ops/sec.

## Triggers (Pro+)

A trigger fires a capture automatically the next time a matching
anomaly recurs on a connection.

- Create from `/anomalies` ("Capture next" row action) or via
  `POST /api/monitor/triggers`.
- One configured trigger per `(connection, metric, anomaly)` triple.
- Auto-clears 24 hours after creation if it never matches.
- If the connection already has an active capture when the trigger
  fires, the trigger queues and re-tries on the next poll.
- Health-gate denial moves the trigger to `skipped` with the gate's
  reason recorded; a `monitor.session.skipped` webhook fires.
- A successful match dispatches a `monitor.session.started` event;
  on close the usual `completed` / `truncated` follow-ups dispatch.

## Scheduled captures (Pro+)

Recurring captures driven by either a fixed interval or a cron
expression.

- **Interval picker** (default UI): minimum 10 seconds, maximum 24 h.
- **Advanced toggle**: standard 5- or 6-field cron expression,
  validated server-side.
- The single-active-session-per-instance rule still applies — a tick
  that lands on a busy connection records `lastSkipReason:
  session_already_active` and moves on.
- Tick respects the same health gate as triggers.

`POST /api/monitor/schedules`, `GET /api/monitor/schedules`,
`DELETE /api/monitor/schedules/:id`. Disabled rows older than the
retention cutoff are pruned by the data-retention sweep.

## Capture-vs-capture diff (Pro+)

`GET /api/monitor/sessions/:id/diff?vs=:otherId` reuses the cross-
reference engine with another capture as the baseline source. The
session detail page exposes this via the **Compare with another
capture** card — pick any other completed capture on the same
connection and the four-section panel populates with the new shapes
and hot-key delta. Slowlog and ACL deltas are scoped to connection
history and stay empty in this mode.

## Value redaction

Set `MONITOR_REDACT_VALUES=true` on the API to scrub value-position
arguments from well-known write commands before the line is persisted
or streamed to the live tail. Coverage is the common write surface
(`SET` / `HSET` / `MSET` / `LPUSH` / `SADD` / `PUBLISH` / ...). Keys,
verbs, and structural fields stay visible so cross-reference and shape
analytics still work. Complex grammars (`XADD`, `ZADD`, `BITFIELD`,
`BITOP`) are intentionally not scrubbed — leave the toggle off when
those payloads are sensitive.

## Data retention

Capture rows respect the existing tier-based retention sweep
(community 7 d, Pro 90 d, enterprise 365 d). Sessions and chunks are
pruned by `ended_at` / `last_ts`; triggers are only pruned in terminal
states (`fired` / `skipped` / `expired` / `cancelled`); schedules are
only pruned when `disabled`. Configured triggers and enabled schedules
are never aged out.

## REST surface

Manual lifecycle:

- `POST /api/monitor/sessions/preflight`
- `POST /api/monitor/sessions`
- `GET  /api/monitor/sessions[?connectionId=&limit=&offset=]`
- `GET  /api/monitor/sessions/:id`
- `DELETE /api/monitor/sessions/:id`
- `GET  /api/monitor/sessions/:id/cross-reference?baseline=<6h|24h|7d|same-hour-last-week>`
- `GET  /api/monitor/sessions/:id/export?format=<json|csv>&command=&client=&key=&afterTs=&beforeTs=`

Pro+:

- `POST/GET /api/monitor/triggers`, `DELETE /api/monitor/triggers/:id`
- `POST/GET /api/monitor/schedules`, `DELETE /api/monitor/schedules/:id`
- `GET /api/monitor/sessions/:id/diff?vs=:otherId`

WebSocket live tail: `/monitor/ws?sessionId=<id>` (rejected on the
demo host).

## Configuration

| Env | Default | Purpose |
| --- | --- | --- |
| `MONITOR_DEFAULT_BYTE_CAP` | 50 MB (community) | Maximum bytes captured per session before truncation |
| `MONITOR_DEFAULT_LINE_CAP` | 5 000 000 (community) | Maximum lines captured per session |
| `MONITOR_REDACT_VALUES` | off | Scrub value-position args of write commands at the source |
| `MONITOR_PROVIDER_OVERRIDE` | off | Test-only override for the pre-flight provider detector |
| `MONITOR_RECENT_OOM_WINDOW_MS` | 5 min | Health-gate window for recent OOM-correlated anomalies |
| `MONITOR_RECENT_FAILOVER_WINDOW_MS` | 2 min | Health-gate window for replication-role changes |
