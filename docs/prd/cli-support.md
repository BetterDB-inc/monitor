# PRD: Integrated CLI for BetterDB Monitor

## Problem Statement

BetterDB Monitor is a monitoring-only tool — users cannot interact with their Valkey/Redis instance from the UI. When investigating an issue spotted in the dashboard (e.g., a suspicious key, a slow command pattern), users must context-switch to a separate terminal running `valkey-cli`. This breaks their workflow and loses the connection context already established in the Monitor.

## Solution

Add an IDE-style CLI panel to the Monitor UI that lets users run Valkey commands and see responses. The panel opens from the bottom of the screen (like VS Code's integrated terminal) and communicates with a dedicated backend WebSocket endpoint. A separate Valkey connection (`BetterDB-CLI`) is used so CLI activity never interferes with monitoring.

The CLI is **opt-in** via the `BETTERDB_UNSAFE_CLI=true` environment variable because it enables write/destructive commands. When disabled (default), the CLI button is hidden and the WebSocket endpoint rejects connections.

## User Stories

1. As a BetterDB user, I want to run Valkey commands from the Monitor UI so I don't have to switch to a separate terminal.
2. As an operator, I want the CLI disabled by default so that accidental write commands can't be issued without explicit opt-in.
3. As a user, I want to see command results formatted like `valkey-cli` so the output is familiar.
4. As a user, I want command history (up/down arrows) so I can re-run previous commands quickly.
5. As a user, I want the CLI to use my currently selected connection so I don't have to manage connections separately.

## Architecture

```
Browser                         Backend (NestJS)
  |                                |
  |  WebSocket /cli/ws             |
  |------------------------------->|
  |  { type: execute,              |  CliGateway
  |    command: "SET foo bar",     |    |
  |    connectionId: "abc" }       |    v
  |                                |  CliService
  |                                |    |
  |                                |    v
  |  { type: result,              |  Dedicated Valkey client
  |    result: "OK",              |  (connectionName: 'BetterDB-CLI')
  |    resultType: "string",      |
  |    durationMs: 2 }            |
  |<-------------------------------|
```

## Feature Flag

| Env Var | Default | Effect |
|---------|---------|--------|
| `BETTERDB_UNSAFE_CLI` | `false` | When `true`: enables CLI WebSocket endpoint, shows CLI button in UI, logs startup warning |

The health endpoint returns `cliEnabled: boolean` so the frontend can conditionally render the CLI toggle.

## Subtasks

### Subtask 1: `BETTERDB_UNSAFE_CLI` env var and guard

- Add `BETTERDB_UNSAFE_CLI` to the Zod env schema (follows `AI_ENABLED` pattern)
- Create a NestJS `CanActivate` guard that returns 403 when disabled
- Log a visible warning on startup when enabled
- Expose `cliEnabled` in the `/health` response

### Subtask 2: CLI WebSocket gateway and command execution

- **WebSocket gateway** at `/cli/ws` using raw `ws` library (same pattern as existing agent gateway)
- **Dedicated Valkey client** per connection ID, named `BetterDB-CLI`, created lazily
- **Command parser** — splits raw input into command + args, handles quoted strings
- **Blocked commands** — SUBSCRIBE, MONITOR, BLPOP, and other blocking commands are rejected with a clear error
- **Response formatting** — matches `valkey-cli` output format:
  - String: `"OK"`
  - Integer: `(integer) 42`
  - Null: `(nil)`
  - Array: `1) "val1"\n2) "val2"`
  - Error: `(error) ERR ...`

### Subtask 3: Frontend CLI panel

- **Collapsible bottom panel** (~30vh), toggled via sidebar button and `Ctrl+`` shortcut
- **WebSocket hook** manages connection lifecycle, auto-reconnects
- **Command history** — up/down arrows, in-memory, 100 entry limit
- **Output area** — scrollable, monospace, themed, max 500 entries
- **Connection-aware** — uses current connection, shows notice on switch

## Out of Scope

- Command autocomplete
- Command persistence across sessions
- Multi-tab CLI sessions
- Blocking command support (SUBSCRIBE, MONITOR, BLPOP, etc.)
- Syntax highlighting
