---
name: betterdb-memory
description: Use when the user asks about memory usage, fragmentation, MEMORY DOCTOR, maxmemory, or when allocated memory will hit its ceiling.
---

# Memory in numbers

## Overview

Report peak, current, bytes per key, fragmentation, and the forecast. The MEMORY DOCTOR text is a letter. Translate it. Do not quote it.

## Steps

1. Follow `betterdb-triage` until you have an instance id.
2. Call `get_memory` and `get_forecast` with `metricKind` `usedMemory`, both with `instanceId`.
3. From `get_memory` stats, report `total.allocated`, `peak.allocated`, `keys.count`, `keys.bytes-per-key`, `dataset.percentage`, and `fragmentation`.
4. From the forecast, report `currentValue`, `ceiling`, `trendDirection`, `growthPercent`, `windowMs`, and `timeToLimitHuman`.
5. State whether a purge or a restart is the relevant next step from the allocator fields, not from the ratio alone. `fragmentation` is total resident memory divided by allocated memory. `fragmentation.bytes` also counts resident memory outside the allocator, such as client buffers. `MEMORY PURGE` reclaims only allocator-held pages.
   - Recommend a purge or a restart only when `allocator-fragmentation.bytes` is greater than 0 and `peak.allocated` is above `total.allocated`. That is the allocator still holding the high-water mark.
   - Use `rss-overhead.bytes` to explain resident memory that is not the allocator. A large ratio with `allocator-fragmentation.bytes` at 0 is overhead, not a purge candidate.
   - A ratio below 1 can mean the process is swapped. It does not show that the peak was released. Do not recommend a purge from a low ratio.
   - If `allocator-fragmentation.bytes` is absent, do not recommend a purge from the ratio.
   - `rdb_changes_since_last_save` of 0 (see `betterdb-durability`) means that peak is not new writes waiting to be saved.

## Forecast reading rules

- `timeToLimitHuman` of "Not projected to reach ceiling" is the answer when `timeToLimitMs` is null and a ceiling exists.
- For `opsPerSec`, `mode` may be `trend` and `ceiling` may be null. Quote the current value and the direction. A large `growthPercent` on a base near 1 op/s is not an incident.
- A license sentence, `insufficientData: true`, or `enabled: false` ends the forecast section. Do not invent a date.
- With `enabled: false`, forecasting is off for this metric. Its `currentValue` 0 and `trendDirection` stable are placeholders. Do not report 0 bytes as current memory. Take current memory from `get_memory`.

## Common mistakes

- Pasting the doctor letter ("Sam, I detected a few issues…") as the diagnosis.
- Recommending `MEMORY PURGE` from `fragmentation` or `fragmentation.bytes` alone. Those include resident memory outside the allocator. Use `allocator-fragmentation.bytes`.
- Putting the ops forecast in the memory answer.
