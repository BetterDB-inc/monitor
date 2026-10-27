---
title: Session Explorer
nav_order: 3.8
---

# Session Explorer

The Session Explorer lists the agent and chat sessions stored in a Valkey or Redis instance and shows what each one holds. You describe a namespace once (a key pattern plus a preset such as LangChain, or your own session template), and BetterDB groups the matching keys into sessions.

## How sessions are read

- Reads open their own connection to each primary, with the connection's command timeout (5 seconds when none is set). They never run on the connection BetterDB uses for monitoring.
- Where the server supports `CLIENT NO-TOUCH` (Valkey and Redis 7.2+), reading a session does not change its keys' idle time. On older servers the page tells you that reads touch keys.
- If BetterDB cannot open its reading connection (for example when `maxclients` is reached), it does not fall back to the monitoring connection. On a single server the read fails with an error. On a cluster, every primary is read: the list is marked partial with the number of failed nodes, and an open session shows an error instead of reporting the session as missing.
- When a preset cannot look a session's keys up directly, BetterDB finds them with `SCAN … MATCH`, capped at 1,000 pages per primary and 10,000 keys. If the cap is hit, the result is marked truncated.

## Read limits

Each key is read up to 2 MB, and a whole session up to 32 MB. Anything beyond that is cut off and the key is marked truncated.

Lists, sets, sorted sets, streams and hashes are read in windows. Before reading, BetterDB divides the key's `MEMORY USAGE` by its length, and skips the key when that average is over 2 MB. Because this check uses the average, it has two limits:

- One very large element among many small ones in a list, set, sorted set or stream keeps the average under the cap, so that element can still be fetched in full.
- Hashes are measured field by field with `HSCAN … NOVALUES` on Valkey 8+ and Redis 7.4+, so large values are skipped. On older servers only the average check applies, and a hash with one very large field among small ones is read in full.
