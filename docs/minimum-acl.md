---
title: Minimum ACL
nav_order: 2.6
---

# Minimum ACL for Monitoring

BetterDB Monitor does not need an admin user. This page lists the commands it sends to a monitored database, gives an `ACL SETUSER` line for read-only monitoring, and shows which features each command enables.

When a command is blocked (`NOPERM`, or "command not available" on a managed service), only the feature that needs it is affected. The connection stays up. For slow log, COMMANDLOG, latency, client list, ACL log, cluster info, cluster slot stats and key size histograms, the web UI shows a banner with the reason and a **Retry** button. Use it after you grant the permission. Other features show no data for that connection, and the API logs the error.

## Table of Contents

- [Read-only monitoring user](#read-only-monitoring-user)
- [Optional add-ons](#optional-add-ons)
- [What each command enables](#what-each-command-enables)
- [Commands that change data or server state](#commands-that-change-data-or-server-state)
- [Sentinel](#sentinel)
- [Migration](#migration)
- [Managed providers](#managed-providers)
- [Checking a user](#checking-a-user)

## Read-only monitoring user

This user can poll every metric BetterDB collects in the background. It has no key permissions, so it can't read or write keys. `resetkeys` removes any key patterns an existing user already has. `SLOWLOG`, `COMMANDLOG` and `CLIENT LIST` do return command arguments, which can include key names and values:

```
ACL SETUSER betterdb on >CHANGE_ME resetkeys -@all +ping +info +select +client|setname +client|list +client|no-touch +config|get +slowlog|get +slowlog|len +commandlog|get +commandlog|len +latency|latest +latency|histogram +latency|history +latency|doctor +memory|stats +memory|doctor +acl|whoami +acl|log +role +cluster|info +cluster|nodes +cluster|shards +cluster|slot-stats +cluster|myid +command|info +dbsize +lastsave +time +module|list
```

If `ACL SETUSER` rejects a rule with `Unknown command or category name`, your server doesn't have that command. Remove the rule and run it again. For example, Redis and Valkey before 8.1 have no `COMMANDLOG`, so drop `+commandlog|get` and `+commandlog|len`.

Persist the user with `ACL SAVE` (when using an ACL file) or `CONFIG REWRITE`, then set the connection's username and password in BetterDB.

On a cluster, create the same user on every node. BetterDB opens its own connection to each node it discovers and reuses the seed connection's credentials.

## Optional add-ons

Append these rules to the line above for the features you use. Each line only adds what it names.

| Add-on | Rules | Enables |
| ------ | ----- | ------- |
| Key sampling | `%R~* +scan +type +ttl +pttl +exists +memory\|usage +object\|freq +object\|idletime +strlen +llen +hlen +scard +zcard +xlen` | Key analytics, KV cache monitoring, cache simulator. `%R~*` (Valkey and Redis 7+) grants read-only key access, and the listed commands return sizes and TTLs, not values. |
| ACL auditing | `+acl\|list +acl\|users +acl\|getuser` | ACL drift detection, config-change webhooks for ACL users, and the "default user" config hazard check. `ACL LIST` returns password hashes for every user. Leave this out if that is a concern. |
| Session capture | `+monitor +acl\|getuser` | Monitor sessions (manual, scheduled and anomaly-triggered captures) and the capture preflight check. `MONITOR` streams every command the server runs, including values. |
| Vector search | `%R~* +ft._list +ft.info +ft.search +ft.tagvals +ft.config\|get +ft.profile +hget +hgetall` | The vector search page and index snapshots. Use the key pattern your indexes cover instead of `~*` if you can. Some search modules don't have `FT.TAGVALS`, `FT.CONFIG` or `FT.PROFILE`; drop those rules if they are rejected. |
| Session explorer | `%R~* +scan +exists +type +pttl +memory\|usage +object\|idletime +strlen +getrange +llen +lrange +hlen +hscan +hstrlen +hmget +hgetall +scard +sscan +smembers +zcard +zrange +xlen +xrange +json.debug\|memory +json.get` | Browsing keys and reading their values in the session explorer. Use the key pattern your sessions live under. |
| Slot migration | `+cluster\|getkeysinslot` | Key names on the slot migration page. `CLUSTER GETKEYSINSLOT` returns key names from any slot regardless of key patterns. |
| Migration analysis | Key sampling, plus `+function\|list +hrandfield +hexpiretime +acl\|users` | The migration analysis report on the source. |

## What each command enables

| Command | Used for | Without it |
| ------- | -------- | ---------- |
| `PING` | Health checks, instance-down detection | The connection reports as unhealthy |
| `INFO` (all sections, including `commandstats`, `latencystats`, `keysizes`) | Dashboard, memory analytics, command stats, Prometheus exporter, anomaly detection, CVE scan, fleet view | Most of the product. Treat it as required. |
| `SELECT` | Connections with a database index other than 0 | Only needed for a non-zero database |
| `CLIENT SETNAME` | Labels BetterDB's own connections in `CLIENT LIST` | Connections still open, unnamed |
| `CLIENT LIST` | Clients page, client analytics, COB pressure, KV cache client detection | Client pages show as unavailable |
| `CLIENT NO-TOUCH` | Session explorer reads don't reset key idle times | Reads still work, and reset idle times |
| `CONFIG GET` | Config drift, config hazard checks, scaling readiness, client eviction and COB pressure detectors, Prometheus persistence metrics | Those checks and detectors skip the connection |
| `SLOWLOG GET`, `SLOWLOG LEN` | Slow log page and slow log analytics | Slow log shows as unavailable |
| `COMMANDLOG GET`, `COMMANDLOG LEN` | COMMANDLOG tabs (Valkey 8.1+) | COMMANDLOG tabs show as unavailable |
| `LATENCY LATEST`, `HISTOGRAM`, `HISTORY`, `DOCTOR` | Latency page, latency analytics, AI chat | Latency data is empty |
| `MEMORY STATS`, `MEMORY DOCTOR` | Memory page, MCP and AI chat tools | Memory details are empty |
| `ACL WHOAMI`, `ACL LOG` | Audit trail of failed auth and denied commands | Audit trail shows as unavailable |
| `ROLE` | Role lookups, key analytics node selection on clusters | Key analytics can't pick which nodes to scan |
| `CLUSTER INFO`, `NODES`, `SHARDS`, `MYID` | Cluster page, node discovery, auto-registration, anomaly detection | Cluster views and per-node metrics are missing |
| `CLUSTER SLOT-STATS` | Slot stats page, hot-slot and orphaned-key detection | Slot stats show as unavailable |
| `CLUSTER GETKEYSINSLOT` | Slot migration page (add-on) | Slot migration details are empty |
| `COMMAND INFO` | Classifying commands in cluster node stats, checking whether the server supports `MONITOR` | Node stats can't classify unfamiliar commands |
| `DBSIZE`, `LASTSAVE`, `TIME` | Key counts, persistence checks, config hazard checks | Those values are empty |
| `MODULE LIST` | CVE scan of loaded modules | Module CVEs aren't checked |

## Commands that change data or server state

None of these are in the lines above. Grant them only if you use the feature.

| Command | Triggered by |
| ------- | ------------ |
| `SLOWLOG RESET`, `COMMANDLOG RESET`, `LATENCY RESET`, `ACL LOG RESET` | The matching `DELETE /metrics/...` API endpoints |
| `CLIENT KILL` | The `DELETE /metrics/clients` API endpoint |
| `UNLINK` | Bulk delete **Execute** |
| `HSET`, `LPUSH`, `DEL` on cache keys | Approving a semantic-cache or agent-cache proposal |
| `DEL` on memory keys | Approving an agent memory forget proposal |
| Anything you type | The CLI terminal. Safe mode blocks dangerous commands unless `BETTERDB_UNSAFE_CLI=true`. |

## Sentinel

For a Sentinel-monitored deployment, BetterDB also connects to the Sentinels themselves. A Sentinel user needs:

```
ACL SETUSER betterdb on >CHANGE_ME resetkeys -@all +ping +info +client|setname +sentinel|masters +sentinel|replicas +sentinel|sentinels +sentinel|config
```

These power Sentinel topology discovery, auto-registration, Sentinel drift detection and the Sentinel config hazard checks.

## Migration

Migration needs more than monitoring. Analysis reads keys on the source (see the add-on above). Execution writes every key to the target, and RedisShake mode can run `FLUSHALL` on the target when **empty target before sync** is on. Use a separate, broader user for migrations. See the [Migration guide](migration).

## Managed providers

Some managed services block commands whatever your ACL says, and BetterDB turns off the affected features automatically. The [provider guides](providers/) list what works on each:

- [Upstash](providers/upstash): no `CONFIG GET`, no COMMANDLOG
- [AWS ElastiCache](providers/aws-elasticache) and [AWS MemoryDB](providers/aws-memorydb): no `CONFIG GET`, no `MONITOR`, limited `CLIENT LIST`
- [Redis Cloud](providers/redis-cloud): `CONFIG GET` and `MONITOR` depend on the plan

## Checking a user

`ACL DRYRUN` tests a command against a user without running it:

```
ACL DRYRUN betterdb SLOWLOG GET 10
ACL DRYRUN betterdb CLIENT KILL ID 1
```

The first returns `OK`; the second returns a "no permissions" error.
