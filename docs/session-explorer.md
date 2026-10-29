---
title: Session Explorer
nav_order: 3.8
---

# Session Explorer

The Session Explorer lists the agent and chat sessions stored in a Valkey or Redis instance and shows what each one holds. You describe a namespace once (a key pattern plus a preset such as LangChain, or your own session template), and BetterDB groups the matching keys into sessions.

## How sessions are read

- Reads open their own connections, with the connection's command timeout (5 seconds when none is set). They never run on the connection BetterDB uses for monitoring. On a cluster, BetterDB reads `CLUSTER NODES` on its own connection to the node you configured, reads that node's slots through the same connection, and connects to the other primaries at the addresses they announce. Every reading connection uses the logical database the monitoring connection is on. If the configured node cannot be opened, BetterDB reads the topology once over the monitoring connection, bounded by the same timeout, and uses it only to find the other primaries.
- Where the server supports `CLIENT NO-TOUCH` (Valkey and Redis 7.2+), reading a session does not change its keys' idle time. On older servers, or where the server or a proxy rejects the command but still answers `PING`, the page tells you that reads touch keys.
- If BetterDB cannot open a reading connection (for example when `maxclients` is reached or authentication fails), it does not fall back to the monitoring connection, and the cause is written to the log. On a single server, or when no cluster primary can be read, the request fails with an error. When some cluster primaries cannot be reached, including the configured node, the session list is marked partial with the number of failed nodes. A node that fails both while finding a session's keys and while reading them is counted once, and a key in a slot that no primary serves counts as a failure. An open session whose keys are found by `SCAN` is marked incomplete when any primary failed; one whose keys are looked up directly is only affected when the primary that holds them failed. Either way, it shows an error instead of reporting the session as missing when nothing could be read.
- When a preset cannot look a session's keys up directly, BetterDB finds them with `SCAN … MATCH`, capped at 1,000 pages per primary and 10,000 keys. If the cap is hit, the result is marked truncated.

## Read limits

Each key is read up to 2 MB; a key cut at that limit is marked truncated. A whole session is read up to 32 MB; past that, the remaining keys are left out and the session as a whole is marked truncated.

Small lists, sets, sorted sets, streams and hashes are read whole; larger ones are read in windows. Before reading, BetterDB divides the key's `MEMORY USAGE` by its length, and skips the key when that average is over 2 MB. Because this check uses the average, it has two limits:

- One very large element among many small ones in a list, set, sorted set or stream keeps the average under the cap, so that element is still transferred from the server in full. The page shows at most 2 MB of the key and marks it truncated.
- On Valkey 8+ and Redis 7.4+, hashes are measured field by field with `HSCAN … NOVALUES`, so oversized values are skipped before they are fetched and the smaller fields are still shown. On older servers only the average check applies, so a hash with one very large field among small ones is transferred in full, then cut to 2 MB like the other types.
