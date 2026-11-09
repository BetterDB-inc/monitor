---
name: betterdb-durability
description: Use when the user asks what a crash would lose, about RDB or AOF, the last save, replicas, replication lag, or whether the instance is a cluster.
---

# Durability check

## Overview

Say what a process death would lose, from persistence and replication INFO. Age the last save against the server clock.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Call `get_info` three times with `instanceId` and `section` set to `server`, `persistence`, and `replication`.
3. Compute last-save age as `server_time_usec / 1000000` minus `rdb_last_save_time`, in seconds. Report that age, `rdb_last_bgsave_status`, `rdb_changes_since_last_save`, and `aof_enabled`.
4. From replication, report `role`, `connected_slaves`, `repl_backlog_active`, and `master_repl_offset`.
5. Read the mode from `server_mode`, `redis_mode`, or `valkey_mode` in the `server` section before any cluster tool. Redis reports `redis_mode`. Valkey reports `server_mode` or `valkey_mode`. For `standalone`, or when none of those fields is present, do not call `get_cluster_nodes`, `get_cluster_node_stats`, `get_cluster_slowlog`, or `get_slot_stats`. Those calls fail with a generic error on a standalone instance. Call them only when a field says `cluster`.
6. For a primary with replicas and a question about the gap growing, call `get_replication_divergence` when that tool exists. If the client reports the tool was not found, say replica-gap history is not in this connector and stop at the INFO fields above. A `Replication divergence detection is unavailable` sentence is the same stop: this monitor build lacks the route (see `betterdb-triage`). Report it and do not retry.

## How to verdict

- `aof_enabled` 0, `rdb_changes_since_last_save` 0, last bgsave `ok`: a crash loses no new writes. Still say how old the snapshot is.
- `rdb_changes_since_last_save` greater than 0 and AOF off: those changes exist only in memory.
- `aof_enabled` 1: a host crash can lose writes not yet fsynced to the AOF. Report `aof_last_write_status`. Say the loss window depends on `appendfsync`, which INFO does not report. Do not state that no writes are lost.
- `role` is `master` and `connected_slaves` is 0: no connected replica is visible from this primary. Do not infer failover eligibility from `repl_backlog_active`. `replicationLag: null` from `get_health` is also what a primary returns when replicas exist, so it is not evidence. Do not use this verdict when `role` is `slave` or `replica`. That instance is itself the promotion candidate.

## Common mistakes

- Calling cluster tools because the question said "cluster" when the mode field is `standalone` or missing.
- Treating an old RDB as data loss when `rdb_changes_since_last_save` is 0.
- Inventing a replica offset gap. `get_replication_divergence` is not in every published connector.
