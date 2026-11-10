---
title: Minimum ACL
nav_order: 2.6
---

# Minimum ACL for Monitoring

BetterDB Monitor does not need an admin user. This page lists the commands it sends to a monitored database, gives an `ACL SETUSER` line for read-only monitoring, and shows which features each command enables.

When a command is blocked (`NOPERM`, or "command not available" on a managed service), only the feature that needs it is affected. The connection stays up. The Slow Log page shows a banner with the reason and a **Retry** button to use after you grant the permission. The Clients and Audit Trail pages show as unavailable, and other features show no data for that connection. Elsewhere, reconnect the connection after you grant a permission so BetterDB checks it again.

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

This user can poll the server metrics BetterDB collects in the background. It has no key permissions, so it can't read or write keys, and the AI cache and agent memory panels stay empty until you add the [AI observability](#ai-observability) rules. `reset` clears any passwords, key patterns and selectors an existing user already has, so running the line again gives the same user:

```
ACL SETUSER betterdb reset on >CHANGE_ME -@all +ping +info +select +client|setname +client|getname +client|list +client|no-touch +config|get +slowlog|get +slowlog|len +commandlog|get +commandlog|len +latency|latest +latency|histogram +latency|history +latency|doctor +memory|stats +memory|doctor +acl|whoami +acl|log +role +cluster|info +cluster|nodes +cluster|shards +cluster|slot-stats +cluster|getslotmigrations +cluster|myid +command|info +dbsize +lastsave +time +module|list
```

This user can still see and change some things:

- `CONFIG GET` returns every setting, including `requirepass` and `masterauth` in plain text. BetterDB reads all settings with `CONFIG GET *`, and ACLs can't hide single parameters. Leave out `+config|get` if that is a concern; config drift, config hazard checks and the detectors that read config then skip the connection.
- `ACL LOG` also allows `ACL LOG RESET`, which clears the ACL log. `RESET` is an argument, not a subcommand, and ACLs can't allow a subcommand without its arguments.
- `SLOWLOG`, `COMMANDLOG` and `CLIENT LIST` return command arguments, which can include key names and values.

If `ACL SETUSER` rejects a rule with `Unknown command or category name`, your server doesn't have that command. Remove the rule and run it again. For example, Redis and Valkey before 8.1 have no `COMMANDLOG`, so drop `+commandlog|get` and `+commandlog|len`. Servers before Valkey 9.0 have no `CLUSTER GETSLOTMIGRATIONS`, so drop `+cluster|getslotmigrations` there.

Persist the user with `ACL SAVE` (when using an ACL file) or `CONFIG REWRITE`, then set the connection's username and password in BetterDB.

On a cluster, create the same user on every node. BetterDB opens its own connection to each node it discovers and reuses the seed connection's credentials.

## Optional add-ons

Append these rules to the line above for the features you use. Each one only adds what it names. Key patterns such as `%R~*` need Valkey or Redis 7+.

### Key sampling

Key analytics, KV cache monitoring and the cache simulator. `%R~*` grants read-only key access, and these commands return sizes and TTLs, not values.

```
%R~* +scan +type +ttl +pttl +exists +memory|usage +object|freq +object|idletime +strlen +llen +hlen +scard +zcard +xlen
```

### AI observability

The AI cache and agent memory panels, and cache proposals. BetterDB reads the `__betterdb:caches` registry, each cache's heartbeat, and its `<name>:__*` keys (stats, config, similarity window, tool policies and tuning history) on every connection. `%R~*:__*` also lets this user read any other key with `:__` in its name; if that is a concern, use one pattern per cache instead, such as `%R~faq:__*`. Trace correlation also checks the cache entry keys named in spans, so it needs the [key sampling](#key-sampling) rules too.

```
%R~__betterdb:* %R~*:__* +get +hget +hgetall +lrange +zrange +zrangebyscore
```

### ACL auditing

ACL drift detection, config-change webhooks, and the "default user" config hazard check. Config-change webhooks read the ACL user list first, so without this add-on they don't report config setting changes either. `ACL LIST` returns password hashes for every user. Leave this out if that is a concern.

```
+acl|list +acl|users +acl|getuser
```

### Session capture

Monitor sessions (manual, scheduled and anomaly-triggered captures) and the capture preflight check. `MONITOR` streams every command the server runs, including values.

```
+monitor +acl|getuser
```

### Vector search

The vector search page, key browsing on it, and index snapshots. `HGET` and `HGETALL` read the values of every hash the key pattern matches, so use the pattern your indexes cover instead of `~*` if you can. `SCAN` still lists key names outside that pattern. Some search modules don't have `FT.TAGVALS`, `FT.CONFIG` or `FT.PROFILE`; drop those rules if they are rejected. BetterDB checks for search with `FT._LIST` when it connects, so reconnect after adding these rules.

```
%R~* +scan +ft._list +ft.info +ft.search +ft.tagvals +ft.config|get +ft.profile +hget +hgetall
```

### Session explorer

Browsing keys and reading their values in the session explorer. Use the key pattern your sessions live under. `SCAN` doesn't apply key patterns, so this user can still list key names outside the pattern; reading values stays limited to it.

```
%R~* +scan +exists +type +pttl +memory|usage +object|idletime +strlen +getrange +llen +lrange +hlen +hscan +hstrlen +hmget +hgetall +scard +sscan +smembers +zcard +zrange +xlen +xrange +json.debug|memory +json.get
```

### Migration analysis

The migration analysis report on the source. Add the key sampling rules too.

```
+function|list +hrandfield +hexpiretime +acl|users
```

## What each command enables

| Command | Used for | Without it |
| ------- | -------- | ---------- |
| `PING` | Health checks, instance-down detection | The connection reports as unhealthy |
| `INFO` (all sections, including `commandstats`, `latencystats`, `keysizes`) | Dashboard, memory analytics, command stats, Prometheus exporter, anomaly detection, CVE scan, fleet view | Most of the product. Treat it as required. |
| `SELECT` | Connections with a database index other than 0, and key analytics, which scans every database listed in `INFO keyspace` | Key analytics only covers the connection's own database |
| `CLIENT SETNAME` | Labels BetterDB's own connections in `CLIENT LIST` | Connections still open, unnamed |
| `CLIENT LIST` | Clients page, client analytics, COB pressure, KV cache client detection | Client pages show as unavailable |
| `CLIENT GETNAME` | **Retry** on the client pages, which checks whether `CLIENT LIST` is now allowed | Client pages work, but **Retry** can't re-enable them after you grant `CLIENT LIST`; reconnect instead |
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
| `CLUSTER GETSLOTMIGRATIONS` | Slot migration progress for atomic slot migrations (Valkey 9.0+) | Atomic migrations don't show; `MIGRATING`/`IMPORTING` moves still do |
| `COMMAND INFO` | Classifying commands in cluster node stats, checking whether the server supports `MONITOR` | Node stats can't classify unfamiliar commands |
| `DBSIZE`, `LASTSAVE`, `TIME` | Key counts, persistence checks, config hazard checks | Those values are empty |
| `MODULE LIST` | CVE scan of loaded modules | Module CVEs aren't checked |

## Commands that change data or server state

Apart from `ACL LOG RESET` (see above) and `SENTINEL CONFIG SET` (see [Sentinel](#sentinel)), none of these are in the lines above. Grant them only if you use the feature. Commands that write keys also need a write key pattern such as `%RW~<prefix>*` for the keys they touch; `%R~*` alone still blocks them.

| Command | Triggered by |
| ------- | ------------ |
| `SLOWLOG RESET`, `COMMANDLOG RESET`, `LATENCY RESET`, `ACL LOG RESET` | The matching `DELETE /metrics/...` API endpoints |
| `CLIENT KILL` | The `DELETE /metrics/clients` API endpoint |
| `SENTINEL CONFIG SET` | Nothing in BetterDB, but `+sentinel\|config` allows it (see [Sentinel](#sentinel)) |
| `UNLINK` | Bulk delete **Execute** |
| `HSET`, `LPUSH`, `LTRIM`, `DEL` on cache keys | Approving a semantic-cache or agent-cache proposal. `LTRIM` caps the tuning history; without it the history list keeps growing. |
| `DEL` on memory keys | Approving an agent memory forget proposal |
| Anything you type | The CLI terminal. Safe mode blocks dangerous commands unless `BETTERDB_UNSAFE_CLI=true`. |

## Sentinel

For a Sentinel-monitored deployment, BetterDB also connects to the Sentinels themselves. A Sentinel user needs:

```
ACL SETUSER betterdb reset on >CHANGE_ME -@all +ping +info +client|setname +client|getname +client|list +acl|whoami +acl|log +sentinel|masters +sentinel|replicas +sentinel|sentinels +sentinel|config
```

The `SENTINEL` rules power topology discovery, auto-registration, Sentinel drift detection and the Sentinel config hazard checks. `CLIENT LIST` and `ACL LOG` feed client analytics and the audit trail, which also poll Sentinels.

BetterDB only reads Sentinel config with `SENTINEL CONFIG GET`, but `+sentinel|config` also allows `SENTINEL CONFIG SET`. ACLs can't allow one without the other. Leave the rule out if that is a concern; the Sentinel config hazard checks then skip the Sentinel.

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
