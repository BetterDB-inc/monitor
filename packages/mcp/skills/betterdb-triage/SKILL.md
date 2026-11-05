---
name: betterdb-triage
description: Use when the user asks whether a Valkey or Redis instance is healthy, what to check first, or starts a BetterDB question before an instance is selected.
---

# Triage this instance

## Overview

Answer "is it healthy?" from one structured summary. Every later BetterDB skill starts here when no instance id is known.

## Steps

1. Call `list_instances`.
2. Count instances whose status is connected.
   - None: say so and stop. Ask the user to connect an instance. Do not call `get_health`.
   - One: pass its id as `instanceId` on every later call.
   - More than one: ask which instance to check, then pass that id.
   `select_instance` stores that id for the rest of the MCP process. Later calls that omit `instanceId` use it. Pass `instanceId` anyway when you already know which instance the question is about.
3. Call `get_health` with that id.
4. Read the result as the verdict. Open another skill only for the signal that is actually off:
   - Fragmentation far from 1, or memory near a ceiling: `betterdb-memory`.
   - A named time window of slow commands: `betterdb-slow-commands`.
   - Hot keys or uneven key access: `betterdb-hot-keys`.
   - "What is slow?" with no command named: `betterdb-latency`.
   - Crash, save, or replica questions: `betterdb-durability`.
   - Cache hit rate or a trace: `betterdb-cache-miss`.
5. Call `get_clients` when `connectedClients` is high or the user asks who is connected.

## How to read get_health

Report hit rate, key count, connected clients, role, replication lag, fragmentation, and `configHazards`. An empty `configHazards` list with no `configHazardsUnavailable` flag means the probe finished and found nothing. `configHazardsUnavailable: true` means the probe did not finish. Findings alongside that flag are partial. A missing `configHazards` with the flag means the probe produced nothing. A response with neither `configHazards` nor `configHazardsUnavailable` means hazard probing is unavailable or unsupported. Do not call any of those cases "no hazards." `replicationLag` is set only for a replica. `null` on a primary means lag was not measured, even when replicas exist.

## Common mistakes

- Calling `get_health`, `get_slowlog`, or `get_memory` before an instance id exists.
- Treating the monitor's own client (`BetterDB-Monitor`, command `client|list`) as application traffic. Check `get_client_activity` before describing who used the database.
- Quoting a growth percent from `get_forecast` without the current level. A rise from about 1 op/s can print as hundreds of percent and still be idle.
