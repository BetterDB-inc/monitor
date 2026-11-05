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
5. State whether a purge or a restart is the relevant next step. A past peak above current usage with fragmentation well below 1 means the allocator is still holding the high-water mark. `rdb_changes_since_last_save` of 0 (see `betterdb-durability`) means that peak is not new writes waiting to be saved.

## Forecast reading rules

- `timeToLimitHuman` of "Not projected to reach ceiling" is the answer when `timeToLimitMs` is null and a ceiling exists.
- For `opsPerSec`, `mode` may be `trend` and `ceiling` may be null. Quote the current value and the direction. A large `growthPercent` on a base near 1 op/s is not an incident.
- A license sentence or `insufficientData: true` ends the forecast section. Do not invent a date.

## Common mistakes

- Pasting the doctor letter ("Sam, I detected a few issues…") as the diagnosis.
- Comparing fragmentation to a "healthy near 1" rule without also giving fragmentation bytes and the peak.
- Putting the ops forecast in the memory answer.
