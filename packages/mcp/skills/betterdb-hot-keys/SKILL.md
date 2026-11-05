---
name: betterdb-hot-keys
description: Use when the user asks about hot keys, uneven key access, a key dominating throughput, or cache-busting keys on a Valkey or Redis instance.
---

# Hot keys

## Overview

Rank keys by access frequency. If that call fails, say so and fall back. Do not retry the same call.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Call `get_hot_keys` with the requested `startTime`, `endTime`, `limit`, and `instanceId`.
3. Read the result:
   - Rows with `signalType`: report key, frequency, and whether the signal was `lfu` or `idletime`.
   - The sentence `Failed to get hot keys`: stop. The monitor replaced the exception with that sentence. Say the hot-key scan failed and the cause was not returned.
   - A license sentence: key analytics is not available on this tier. Say that.
4. Fall back, in order, and label each fallback:
   - `get_largest_keys` ranks memory, not access frequency. A license sentence here is the result.
   - `get_commandlog_patterns` for the same window. These are slow or large commands, not a hot-key ranking.
5. Do not propose a key delete, rename, or TTL from a failed hot-key call.

## Common mistakes

- Calling `get_hot_keys` again with a wider window after `Failed to get hot keys`. The failure is not a bad timestamp.
- Presenting `get_largest_keys` or two slowlog patterns as the hot-key list.
- Using `get_slowlog_patterns` as the fallback for a time window. That tool has no `startTime`.
