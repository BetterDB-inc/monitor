---
title: KV Cache Monitoring
nav_order: 3.7
---

# KV Cache Monitoring (LMCache)

BetterDB Monitor can show how much of a Valkey instance an
[LMCache](https://github.com/LMCache/LMCache) deployment is using as its remote
KV cache backend, how well that cache is hitting, and whether Valkey is set up
in a way that will hurt it. It is a Pro feature. On other tiers the KV Cache
page shows an upgrade prompt.

## Table of Contents

- [What it shows](#what-it-shows)
- [Detection](#detection)
- [Footprint](#footprint)
- [Hit rate](#hit-rate)
- [Advisories and alerts](#advisories-and-alerts)
- [Exported metrics](#exported-metrics)
- [Configuration](#configuration)
- [Known LMCache quirks](#known-lmcache-quirks)

## What it shows

The **KV Cache** page is in the sidebar of each connection whose keyspace
BetterDB scans itself. It is hidden on agent, external and Sentinel
connections, and on cluster members, Sentinel replicas and retired nodes, whose
keys are covered by their seed or primary connection. The page has two halves:

- **Footprint**, read from Valkey itself: the estimated number of per-worker
  cached chunks and bytes, a per-model breakdown, how much of `used_memory`
  and `maxmemory` LMCache holds, and the share of keys with a TTL.
- **Hit rate**, read from LMCache's own Prometheus metrics: token hit rate over
  time, per engine and model, plus the bytes LMCache read from and wrote to
  remote storage. Valkey cannot measure this, so it appears only after you link an
  engine (see [Hit rate](#hit-rate)).

The page also lists advisories and lets you edit the alert settings for the
connection. When LMCache is not detected, it says so and lists other databases
that hold keys.

Page controls:

- A date range picker for the charts, defaulting to the last 6 hours.
  A range covers at most 31 days and 50,000 stored samples. When a range holds more
  samples, the page shows only the most recent ones and says so.
- **Refresh**, which re-collects the footprint now.
- The alert settings sheet (see [Per-connection switches](#per-connection-switches)).
- **Rescan now** on the not-detected view, which collects the footprint again.
- **Link an engine** on the not-detected view, which opens the same dialog as
  the engines table, so you can link an engine when BetterDB sees no keys.
- An engines table with an **Enabled** switch, the time each engine was last
  seen, and its last error. Turning an engine off or on restarts its counters
  from the next reading, so traffic from while it was off is never counted.
  The table does not edit an engine's scrape URL; to point an engine at a new
  endpoint, delete it and link it again.
- **Delete** on an engine, behind a confirm dialog. It removes the engine and
  deletes all of its stored samples, so it drops out of the charts and hit
  rates at once. It cannot be undone.

### Advisories

The page shows an advisory for each of these conditions:

- **LMCache keys can never be evicted.** The `maxmemory-policy` starts with
  `volatile-` and at least 90% of the sampled LMCache keys have no TTL. Fix it
  by setting `valkey_enable_ttl` (with `valkey_ttl_sec`) on the `valkey://`
  connector, or by switching to an `allkeys-*` policy.
- **Orphaned `kv_bytes` keys.** Some sampled `kv_bytes` keys have no matching
  `metadata` key (`redis://` layout). `redis://` removes them only when it
  tries to read them.
- **Keys in other databases.** Other databases hold keys, but only the
  connection's own database is scanned.

## Detection

BetterDB does not need any LMCache-specific setup on Valkey to detect it. It
recognises LMCache by the shape of its keys:

```
<model_name>@<world_size>@<worker_id>@<chunk_hash_hex>@<dtype>
```

Layerwise setups append `@<layer_id>`. Tagged keys then append any number of
`@<key>%<value>` tags, for example `@tenant%acme@lang%en`. Model names can
contain `/`, and the chunk hash is hex with an optional leading `-`. The
`dtype` is one of LMCache's `TORCH_DTYPE_TO_STR_DTYPE` strings: `half`,
`bfloat16`, `float`, `double`, `int8`, `uint8`, `int16`, `int32`, `int64`,
`bool`, `fp8_e4m3fn`, `fp8_e4m3fnuz`, `fp8_e5m2` or `fp8_e5m2fnuz`. For
example, fp16 caches use `half` and fp32 caches use `float`.

LMCache's multiprocess (MP) mode has its own Valkey L2 adapter, which writes one
key per chunk object in a different shape:

```
[<key_prefix>@]<model_name>@<kv_rank:08x>@<object_group_hex>@<chunk_hash_hex>[@<cache_salt>]
```

The KV rank is 8 lowercase hex digits, the chunk hash is the hex of the hash
bytes (at least 8 bytes), and the optional cache salt has no `@`, `/` or `\`.
These keys carry no dtype, so their per-model rows show the dtype as
`unknown`. They count as single-key chunks. When a key prefix is configured,
the model name is the segment right before the KV rank, so a model name that
itself contains `@` is shortened to its last segment.

The three LMCache remote connectors write different key layouts:

| Connector (scheme)       | Keys per chunk | Key suffix                              | TTL                                                                | Client `lib-name`        |
| ------------------------ | -------------- | --------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `redis://` (redis-py)    | 2              | `kv_bytes` and `metadata`, no separator | never                                                              | `redis-py`               |
| `valkey://` (GLIDE sync) | 1              | none                                    | only with `valkey_enable_ttl` (`valkey_ttl_sec`, default 24 hours) | `GlidePySync(lmcache:*)` or `GlidePySync(lmcache)` |
| `resp://` (native C++)   | 1              | none                                    | never                                                              | none sent                |
| MP mode Valkey L2        | 1              | none                                    | never                                                              | not matched              |

BetterDB reports the layout as `two_key`, `single_key` or `mixed`.

LMCache is considered present on a connection when either of these holds:

- at least 5 keys in the scanned range match the key shape, or
- a client with a `GlidePySync(lmcache:*)` or bare `GlidePySync(lmcache)`
  library name is connected to the scanned database (its `CLIENT LIST`
  `db=` field matches).

Only the database the connection is configured for is scanned. LMCache's
`resp://` connector has no database selection and always writes to DB 0, so a
connection pointed at another database will not see those keys. The page lists
the other databases that hold keys. On a cluster connection, BetterDB scans the
primaries. Cluster members registered automatically always use DB 0, while the
seed connection keeps its configured database, so on a multi-database cluster
(Valkey 9) with LMCache in another database only the seed's shard is counted.
A cluster seed with no registered members scans only its own shard, and the
snapshot is marked incomplete when other primaries own slots. A seed that is a
replica owns no slots and is reported as 0 primaries scanned. Scanned members
are matched to the cluster view by node id, and by `host:port` (or announced
hostname) when the stored node id is stale. Memory figures are
summed across primaries; if any primary has no `maxmemory` limit the total is
treated as unlimited, and a `maxmemory-policy` that differs between primaries
is reported as `mixed`.

## Footprint

Scanning every key of a large instance would be expensive, so the footprint is
a bounded SCAN plus a sample, extrapolated to the whole keyspace.

1. `SCAN` runs without a `MATCH` pattern, 1000 keys per call, and BetterDB
   keeps the keys that have the LMCache shape. It stops when the SCAN
   finishes or hits one of the two budgets below.
2. Up to `KV_CACHE_SAMPLE_KEYS` of the matched keys, spread evenly across the
   match list, are sampled with `MEMORY USAGE` and `TTL`.
3. If the SCAN stopped early, the matched counts are scaled by
   `DBSIZE / scanned keys`. Bytes are the mean sampled `MEMORY USAGE`
   multiplied by the (scaled) matched key count. Both are estimates. When
   `MEMORY USAGE` answers for none of the samples (for example an ACL without
   `+memory`), bytes and the memory share are reported as unknown rather than
   zero.
   `COUNT` is only a hint, so "scanned keys" is the number of keys SCAN
   returned. A full SCAN uses `DBSIZE` and is not scaled. If more keys match
   than `KV_CACHE_MATCH_MAX_KEYS`, the scanned count is reduced by the share
   of matches kept, so the dropped matches are still counted.

| Variable                         | Default  | Description                                                          |
| -------------------------------- | -------- | -------------------------------------------------------------------- |
| `KV_CACHE_FOOTPRINT_INTERVAL_MS` | `300000` | How often the footprint is collected for each connection (5 minutes) |
| `KV_CACHE_SCAN_MAX_KEYS`         | `200000` | Maximum number of keys visited by SCAN per collection                |
| `KV_CACHE_MATCH_MAX_KEYS`        | `2000`   | Maximum number of matched keys kept per collection                   |
| `KV_CACHE_SAMPLE_KEYS`           | `500`    | Number of matched keys sampled with `MEMORY USAGE` and `TTL`         |

An unset, non-numeric, too-small or too-large value falls back to the default.
The interval must be between `60000` (1 minute) and `86400000` (24 hours), the
matched-key cap at least `5` (the detection threshold), and the other key
budgets at least `1`.

When a complete collection finds no LMCache on a connection, BetterDB backs off
and does not collect it again for `KV_CACHE_UNDETECTED_RECHECK_MS` (default
`1800000`, 30 minutes), instead of every footprint interval. If you start
LMCache after BetterDB, it can take up to that long to be detected. Press
**Rescan now** to collect immediately, or lower the variable (minimum `60000`).
A collection that finds LMCache ends the back-off.

A collection that could not read every slot owner (for example a cluster seed
with no registered members) is incomplete, so a miss does not prove LMCache is
absent. BetterDB keeps polling such a connection at the footprint interval, but
after 3 incomplete collections in a row that find no LMCache it backs off for
`KV_CACHE_UNDETECTED_RECHECK_MS` as well.

Per-model chunks and bytes come from the same sample, split in proportion to
what the sample contains. The share of keys without a TTL and the LMCache
share of `used_memory` are derived the same way, so on large caches they are
approximations.

Chunk counts are per worker: a chunk cached by each of four tensor-parallel
workers counts four times. Layerwise keys count as a fraction of a chunk,
one over the number of distinct layers seen for that model, so a chunk split
across all layers counts once. A sampled key whose `TTL` command fails is
left out of the share of keys without a TTL.

## Hit rate

Valkey cannot tell you the hit rate. `keyspace_hits` and `keyspace_misses` are
server-wide, and no LMCache connector issues commands that would let the server
attribute them. The numbers have to come from LMCache's own Prometheus metrics,
so BetterDB offers two ways to link an LMCache engine.

The hit rate is defined as:

```
hit rate = hit tokens / requested tokens
```

Both are counters summed over the buckets in the range (`num_hit_tokens` and
`num_requested_tokens`). A bucket with no requested tokens has no hit rate.

### Link by scrape

BetterDB fetches the engine's Prometheus endpoint itself, every
`KV_CACHE_SCRAPE_INTERVAL_MS` (default `30000`, 30 seconds). The value must be
a whole number of milliseconds between `1000` and `86400000` (one day); any
other value is logged and falls back to the default.

On **Link engine** choose scrape and give:

- the metrics URL, `http` or `https`, for example `http://vllm:8000/metrics`;
- optionally an auth header value, sent verbatim as the `Authorization`
  header. It is stored encrypted when connection encryption is configured and
  is never returned by the API. If it can no longer be decrypted, for example
  after `ENCRYPTION_KEY` changes, the engine is not scraped and shows the error
  `auth header could not be decrypted` until you enter the header again.

BetterDB performs a test scrape when you save. If the endpoint cannot be
reached, returns an error status or exceeds the limits, the link is rejected
with `Test scrape failed: <reason>`. If it answers but exposes no `lmcache:`
metrics, the link is saved with the error `no lmcache metrics found` so that
you can see it and fix the endpoint.

Scrapes time out after 5 seconds, accept responses up to 5 MiB and do not
follow redirects.

On self-hosted installs, the URL guard allows private network addresses by
default, because LMCache metrics usually live on the cluster network. Set
`KV_CACHE_SCRAPE_BLOCK_PRIVATE=true` (also `1`, `yes` or `on`, in any case) to
refuse private and loopback addresses as well. `false`, `0`, `no`, `off` or an
empty value keep them allowed; any other value is logged and treated as `true`. In cloud mode, private and loopback addresses are always
refused and the variable has no effect. Link-local addresses (`169.254.0.0/16`, which
includes cloud metadata endpoints, and `fe80::/10`) are always refused,
whatever the setting.

The guard checks every address a hostname resolves to, and the scrape then
connects only to an address that passed the check. A DNS answer that changes
between the check and the connection cannot redirect a scrape to a refused
address.

When you change the metrics URL of a linked engine to a different origin
(scheme, host or port) and a stored auth header exists, BetterDB refuses the
update with a `400` unless you also supply an auth header. Send an empty
string to clear the header. This keeps a stored credential from being sent to
a host you did not give it to.

### Link by OTLP

If BetterDB cannot reach the engine, push the metrics from an OpenTelemetry
Collector that can. Create an OTLP engine on the page; it shows an engine id
(generated as `lmc-<12 hex characters>`, or one you choose using letters,
digits, `.`, `_` and `-`, up to 64 characters) and a ready-made collector
config:

```yaml
receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: lmcache
          scrape_interval: 30s
          static_configs:
            - targets: ['vllm:8000']
          metric_relabel_configs:
            - source_labels: [__name__]
              regex: 'lmcache:.*'
              action: keep
processors:
  resource:
    attributes:
      - key: betterdb.lmcache.engine
        value: lmc-3f9a1c7e2b40
        action: upsert
exporters:
  otlphttp:
    metrics_endpoint: <betterdb-url>/v1/external/metrics
    headers:
      Authorization: 'Bearer ${env:BETTERDB_OTEL_INGEST_TOKEN}'
service:
  pipelines:
    metrics:
      receivers: [prometheus]
      processors: [resource]
      exporters: [otlphttp]
```

Point `targets` at the LMCache metrics endpoint and `<betterdb-url>` at the
BetterDB API origin. The `metric_relabel_configs` rule keeps only `lmcache:`
metrics, so the rest of the vLLM endpoint is not forwarded and counted as
dropped. The receiver's own `up` and `scrape_*` series are not affected by it
and, being gauges, are still dropped as `unsupported_type`. Use `metrics_endpoint`, not `endpoint`, as described in
[OpenTelemetry (OTLP)](opentelemetry#metrics-ingestion).

The `Authorization` header is needed only when `OTEL_INGEST_TOKEN` is set on
Monitor. If it is not set, remove the `headers` block.

The `betterdb.lmcache.engine` resource attribute is what routes the points:
its value must equal the engine id on the page. Only sums are accepted, with
cumulative or delta temporality; gauges, histograms and summaries are dropped
as `unsupported_type`.

On a resource with the attribute, metrics named `redis.*` or `valkey.*` are
not routed to KV cache: they continue to the external Valkey connection, so
adding the attribute to a pipeline that also carries a Valkey receiver does not
cut that connection off. Every other metric on the resource goes to KV cache.

A resource without the attribute is also routed to KV cache when every metric
in it has a name starting with `lmcache:`. Such points cannot match an engine,
so they are dropped as `unknown_engine`.

Points whose `betterdb.lmcache.engine` value does not match a linked engine
are dropped with the reason `unknown_engine`. The same reason is used when the
engine is disabled or the instance has no Pro license. See the
[drop reasons](opentelemetry#metrics-ingestion).

### Counters

Either way, BetterDB records these LMCache counters per minute, per engine and
model (`model_name` label): `num_requested_tokens`, `num_hit_tokens`,
`num_lookup_tokens`, `num_lookup_hits`, `num_remote_read_bytes`,
`num_remote_write_bytes`, `num_remote_read_requests`,
`num_remote_write_requests` and `remote_ping_errors`. Counter resets are handled.

A disabled engine is not scraped, accepts no OTLP points, never alerts and
exports no hit-rate series.

## Advisories and alerts

The page shows advisories, and two webhook events carry the same signals. Both
are Pro and are described in [Webhooks](webhooks#kv_cachehit_rate_low-pro).

### Low hit rate (`kv_cache.hit_rate_low`)

Evaluated every minute for each enabled engine and model over the last 15
minutes. It fires when the hit rate in that window is at or below the
connection's threshold:

- The default threshold is 0.2 (20%) and the maximum is 0.9.
- A window is checked only when it holds at least 10,000 requested tokens, so
  a quiet engine does not alert on a handful of requests.
- Like other threshold alerts it fires once, and re-arms after the hit rate
  recovers above `threshold × 1.1` (a fixed hysteresis factor of 0.9 is
  applied as `threshold × (2 − 0.9)`). A threshold of 0.2 re-arms above 0.22.
  A per-webhook `alertConfig.hysteresisFactor` does not change this.

### Eviction risk (`kv_cache.eviction_risk`)

Evaluated on every footprint collection. It reports two reasons, each as its own
alert that fires when it becomes active. `unevictable` clears on the first
collection where it is no longer active. `evicting` clears only after 3
collections in a row without it (about 15 minutes at the default 5-minute
interval), so a cache that evicts in bursts does not fire and clear on every
burst:

| Reason        | Active when                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unevictable` | `maxmemory-policy` starts with `volatile-` and at least 90% of the sampled LMCache keys have no TTL, so Valkey has nothing it is allowed to evict |
| `evicting`    | keys were evicted since the previous collection, `used_memory` is at least 90% of `maxmemory`, and LMCache holds at least half of `used_memory` (or its share is unknown) |

Most LMCache connectors never set a TTL, which makes `unevictable` a common
misconfiguration: under a `volatile-*` policy, the cache fills Valkey and then
writes start failing.

### Per-connection switches

Each connection has its own alert settings, on the page: hit-rate alerts on or
off, the hit-rate threshold, and eviction alerts on or off. Both alerts are on
by default.

## Exported metrics

Three Prometheus series, at `/api/prometheus/metrics` in the `full` export
profile (they are not part of `vitals`):

| Metric                       | OTel name                    | Labels                                           | Description                                     |
| ---------------------------- | ---------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `betterdb_kv_cache_hit_rate` | `betterdb.kv_cache.hit_rate` | `connection`, `connection_id`, `engine`, `model` | LMCache token hit rate over the last 15 minutes |
| `betterdb_kv_cache_chunks`   | `betterdb.kv_cache.chunks`   | `connection`, `connection_id`, `model`           | Estimated LMCache chunks stored                 |
| `betterdb_kv_cache_bytes`    | `betterdb.kv_cache.bytes`    | `connection`, `connection_id`, `model`           | Estimated bytes held by LMCache keys            |

See [Prometheus Metrics](prometheus-metrics#kv-cache-metrics) for the full
reference. Hit-rate series exist only for enabled engines whose window has
requested tokens; they are removed when that stops being true. The `engine`
label is the engine name, which must be unique per connection. `connection`
is the connection's `host:port`; `connection_id` keeps apart connections that
share it, such as agent connections.

## Configuration

| Variable                         | Default  | Description                                                                                    |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `KV_CACHE_FOOTPRINT_INTERVAL_MS` | `300000` | Footprint collection interval. An invalid value, one below `60000` or one above `86400000` falls back to the default |
| `KV_CACHE_SCAN_MAX_KEYS`         | `200000` | SCAN budget per collection. An invalid value or one below `1` falls back to the default        |
| `KV_CACHE_MATCH_MAX_KEYS`        | `2000`   | Matched-key cap per collection. An invalid value or one below `5` falls back to the default    |
| `KV_CACHE_SAMPLE_KEYS`           | `500`    | Keys sampled for size and TTL. An invalid value or one below `1` falls back to the default     |
| `KV_CACHE_UNDETECTED_RECHECK_MS` | `1800000` | How long a connection where LMCache was not found waits before the next collection (30 minutes). An invalid value or one below `60000` falls back to the default |
| `KV_CACHE_SCRAPE_INTERVAL_MS`    | `30000`  | Engine scrape interval, `1000` to `86400000`. Other values are logged and fall back to the default |
| `KV_CACHE_SCRAPE_BLOCK_PRIVATE`  | `false`  | `true`/`1`/`yes`/`on` also refuses private and loopback scrape targets; unrecognised values do too. Cloud mode always refuses them |
| `OTEL_INGEST_TOKEN`              | unset    | When set, OTLP pushes (including LMCache engines) must send `Authorization: Bearer <token>`    |

## Known LMCache quirks

These come from LMCache itself (tested against 0.5.5), not from BetterDB.

- **`valkey://` auth.** LMCache passes `ServerCredentials(username, password)`
  positionally to GLIDE, whose signature is `(password, username)`. Password
  only fails with `NOAUTH`, and user plus password with `WRONGPASS`. Workaround:
  swap `valkey_username` and `valkey_password` in the LMCache config.
- **`valkey://` needs `valkey-glide-sync`**, not `valkey-glide`, which is
  async-only.
- **`resp://` always uses DB 0**, and a `get` on a missing key hangs.
- **No TTL by default.** No connector sets a TTL, except `valkey://` when
  `valkey_enable_ttl` is on. Pair this with a `volatile-*` eviction policy and
  Valkey can never evict the cache (see [eviction risk](#eviction-risk-kv_cacheeviction_risk)).
