# Cache Size Simulator (Pro)

The Cache Size Simulator measures how much memory your data really uses, projects it forward, and tells you when you will hit `maxmemory` and which cloud node would hold it.

## How the size is measured

When you open the page, BetterDB shows the figures from `INFO` straight away and starts sampling in the background:

1. It walks the keyspace with `SCAN` and asks each sampled key for its `TYPE` and `MEMORY USAGE … SAMPLES 0`.
2. It works out how many keys of each type you have and how much their sizes vary. Types are counted on up to 10 times as many keys as are sized, so the type mix is accurate even when sizing is the expensive part.
3. It spends the rest of its budget on the types whose sizes vary most (`SCAN … TYPE`), so a few large hashes are not drowned out by millions of small strings.

Sampling starts at 4,000 keys and keeps going until the 95% range is within ±5% of the estimate, up to 50,000 keys or 60 seconds, whichever comes first. While it runs past the initial target, the page says it is sampling more keys for a tighter range.

Heavily skewed key types, where a few keys are far larger than the rest, get at least 20,000 samples and a wider range. The extra width accounts for very large keys that the sample may have missed.

On a cluster the budget is split across primaries in proportion to their key counts. maxmemory is the sum across primaries, or no limit if any primary has none; if the primaries use different eviction policies, the page says so instead of naming one. A result that stops at the time limit is marked as partial and has a wider range. Results are cached for 15 minutes; **Refresh sample** starts a new one. If a refresh fails, the page keeps the previous result and shows the error beside it.

BetterDB never uses `KEYS` or `RANDOMKEY`. Every command it sends is read-only.

## What the range means

"18.4 GiB ± 0.3" means the true dataset size is between 18.1 and 18.7 GiB with 95% confidence. The range shrinks as more keys are sampled and grows when key sizes vary a lot.

A sample cannot see a key it never picked, so when not every key was sampled the range is never narrower than the gap between the sampled total and the dataset memory the server reports (`used_memory_dataset`). A single huge key the sample missed shows up as a wide range rather than a confident wrong answer.

The chart's shaded band starts at this range and widens in proportion to the projected key count.

## Inputs

Every input is filled in from measured data and can be changed; the chart redraws as you type.

- **Growth rate** — fitted from the last 30 days of key counts. With less than a day of history it starts at 0.
- **In-place growth** — memory growth over the last 30 days that new keys do not explain, such as streams, lists or hashes growing in place. It is added on top of key growth.
- **Key TTL** — with a TTL, new keys expire after that many days, so the key count levels off at rate × TTL.
- **Average key size** — from the sample.
- **Per-key overhead** — memory per key on top of the average key size. Sampled sizes (`MEMORY USAGE`) already include it, so it is 0 once sampling finishes; before that the INFO-based average uses 88 bytes.
- **maxmemory** — from `INFO`; 0 means no limit.

The headline about reaching maxmemory always looks six months ahead, whichever horizon the chart shows.

## Requirements and limits

- Needs `SCAN … TYPE` (Redis 6.0+ / any Valkey) and `MEMORY USAGE`. If either is missing or blocked by ACLs, the page shows the `INFO` figures and lets you enter values by hand.
- Cloud node sizes are capacity only (no prices) and were checked against each provider's published specs on the date shown in the catalog.
- Node picks keep the projection under 80% of usable memory: 75% of node memory on ElastiCache (default reserved memory), all of it on MemoryDB (no reserved memory; maxmemory is the node size), 80% on Memorystore and Azure Cache for Redis.
- Memorystore picks assume one replica per shard, so a cluster tops out at 125 shards.
- Azure Cache for Redis tiers are marked legacy: Microsoft no longer offers them to new customers.
