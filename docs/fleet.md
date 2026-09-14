# Fleet overview

`GET /fleet/summary` rolls every registered Valkey/Redis connection into one
"are we green?" payload: `overallStatus` (`healthy`/`degraded`/`unhealthy`/
`waiting`) plus per-instance `status`, `uptimeSec`, `memoryUsedBytes`,
`memoryMaxBytes`, `memPct`, `opsPerSec`, `connectedClients`,
`replicationRole`, and `lastSeen`.

It reuses `ConnectionRegistry.list()` + `HealthService.getHealth()` + INFO
`server`/`memory`/`stats`/`clients`/`replication` sections — no new Redis
commands. Instances fan out with `Promise.allSettled` and a 5s per-instance
timeout, so one slow node never blocks the fleet; failures map to
`down`/`unknown` with `null` metrics and an `error` string.

The route is global (no `X-Connection-Id` header) and cached in-memory for
15s. Workspace scoping is automatic: the registry only lists the caller's
tenant connections. `memPct` is `null` when `maxmemory` is 0 (no limit).

The `/fleet` page polls every 15s (pauses when the tab is hidden), filters by
status, searches by name/host, and sorts by name, memory %, or ops/sec.
Clicking a row — or Tabbing to an instance name and pressing Enter — opens it
in the Dashboard. A failed background poll keeps the last good data on screen
with a retry note instead of replacing the table.

No new `betterdb_fleet_*` Prometheus metrics in v1; per-connection
`betterdb_memory_used_bytes`, `betterdb_connected_clients`, and
`betterdb_instantaneous_ops_per_sec` already cover alerting. Provider
migration guides live in `docs/providers/`.
