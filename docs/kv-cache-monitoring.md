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

The **KV Cache** page, in the sidebar for each connection, has two halves:

- **Footprint**, read from Valkey itself: the estimated number of cached chunks
  and bytes, a per-model breakdown, how much of `used_memory` and `maxmemory`
  LMCache holds, and the share of keys with a TTL.
- **Hit rate**, read from LMCache's own Prometheus metrics: token hit rate over
  time, per engine and model, plus the raw token and remote read/write
  counters. Valkey cannot measure this, so it appears only after you link an
  engine (see [Hit rate](#hit-rate)).

The page also lists advisories and lets you edit the alert settings for the
connection. When LMCache is not detected, it says so and lists other databases
that hold keys.

Page controls:

- A date range picker for the charts, defaulting to the last 6 hours.
- **Refresh**, which re-collects the footprint now.
- The alert settings sheet (see [Per-connection switches](#per-connection-switches)).
- **Rescan now** on the not-detected view, which collects the footprint again.
- An engines table with an **Enabled** switch, the time each engine was last
  seen, and its last error. Turning an engine off or on, or changing its
  scrape URL, restarts its counters from the next reading, so traffic from
  while it was off is never counted.
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

Layerwise setups append `@<layer_id>`, and tagged keys end in `@k%v`. Model
names can contain `/`. The `dtype` must be one of `bfloat16`, `float16`,
`float32`, `float8_e4m3fn`, `float8_e5m2`, `uint8` or `int8`.

The three LMCache remote connectors write different key layouts:

| Connector (scheme)       | Keys per chunk | Key suffix                              | TTL                                                                | Client `lib-name`        |
| ------------------------ | -------------- | --------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `redis://` (redis-py)    | 2              | `kv_bytes` and `metadata`, no separator | never                                                              | `redis-py`               |
| `valkey://` (GLIDE sync) | 1              | none                                    | only with `valkey_enable_ttl` (`valkey_ttl_sec`, default 24 hours) | `GlidePySync(lmcache:*)` |
| `resp://` (native C++)   | 1              | none                                    | never                                                              | none sent                |

BetterDB reports the layout as `two_key`, `single_key` or `mixed`.

LMCache is considered present on a connection when either of these holds:

- at least 5 keys in the scanned range match the key shape, or
- a client with a `GlidePySync(lmcache:*)` library name is connected.

Only the database the connection is configured for is scanned. LMCache's
`resp://` connector has no database selection and always writes to DB 0, so a
connection pointed at another database will not see those keys. The page lists
the other databases that hold keys. On a cluster connection, BetterDB scans the
primaries.

## Footprint

Scanning every key of a large instance would be expensive, so the footprint is
a bounded SCAN plus a sample, extrapolated to the whole keyspace.

1. `SCAN` runs with a `MATCH` pattern that selects LMCache-shaped keys,
   1000 keys per call, until it finishes or hits one of the two budgets
   below.
2. Up to `KV_CACHE_SAMPLE_KEYS` of the matched keys, spread evenly across the
   match list, are sampled with `MEMORY USAGE` and `TTL`.
3. If the SCAN stopped early, the matched counts are scaled by
   `DBSIZE / scanned keys`. Bytes are the mean sampled `MEMORY USAGE`
   multiplied by the (scaled) matched key count. Both are estimates.
   `COUNT` is only a hint and `MATCH` hides the keys it filters out, so
   "scanned keys" is the number of SCAN calls × 1000, not an exact count.
   A full SCAN uses `DBSIZE` and is not scaled. If more keys match than
   `KV_CACHE_MATCH_MAX_KEYS`, the scanned count is reduced by the share of
   matches kept, so the dropped matches are still counted.

| Variable                         | Default  | Description                                                          |
| -------------------------------- | -------- | -------------------------------------------------------------------- |
| `KV_CACHE_FOOTPRINT_INTERVAL_MS` | `300000` | How often the footprint is collected for each connection (5 minutes) |
| `KV_CACHE_SCAN_MAX_KEYS`         | `200000` | Maximum number of keys visited by SCAN per collection                |
| `KV_CACHE_MATCH_MAX_KEYS`        | `2000`   | Maximum number of matched keys kept per collection                   |
| `KV_CACHE_SAMPLE_KEYS`           | `500`    | Number of matched keys sampled with `MEMORY USAGE` and `TTL`         |

An unset, non-numeric or too-small value falls back to the default. The
interval must be at least `60000` (1 minute), and each key budget must be at
least `1`.

Per-model chunks and bytes come from the same sample, split in proportion to
what the sample contains. The share of keys without a TTL and the LMCache
share of `used_memory` are derived the same way, so on large caches they are
approximations.

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
`KV_CACHE_SCRAPE_INTERVAL_MS` (default `30000`, 30 seconds). An unset, non-numeric or
sub-second value falls back to the default.

On **Link engine** choose scrape and give:

- the metrics URL, `http` or `https`, for example `http://vllm:8000/metrics`;
- optionally an auth header value, sent verbatim as the `Authorization`
  header. It is stored encrypted when connection encryption is configured and
  is never returned by the API.

BetterDB performs a test scrape when you save. If the endpoint cannot be
reached, returns an error status or exceeds the limits, the link is rejected
with `Test scrape failed: <reason>`. If it answers but exposes no `lmcache:`
metrics, the link is saved with the error `no lmcache metrics found` so that
you can see it and fix the endpoint.

Scrapes time out after 5 seconds, accept responses up to 5 MiB and do not
follow redirects.

The URL guard allows private network addresses by default, because LMCache
metrics usually live on the cluster network. Set
`KV_CACHE_SCRAPE_BLOCK_PRIVATE=true` to refuse private and loopback
addresses as well. Link-local addresses (`169.254.0.0/16`, which
includes cloud metadata endpoints, and `fe80::/10`) are always refused,
whatever the setting.

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
BetterDB API origin. Use `metrics_endpoint`, not `endpoint`, as described in
[OpenTelemetry (OTLP)](opentelemetry#metrics-ingestion).

The `Authorization` header is needed only when `OTEL_INGEST_TOKEN` is set on
Monitor. If it is not set, remove the `headers` block.

The `betterdb.lmcache.engine` resource attribute is what routes the points:
its value must equal the engine id on the page. Only sums are accepted, with
cumulative or delta temporality; gauges, histograms and summaries are dropped
as `unsupported_type`.

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
alert that fires when it becomes active and clears when it stops being active:

| Reason        | Active when                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unevictable` | `maxmemory-policy` starts with `volatile-` and at least 90% of the sampled LMCache keys have no TTL, so Valkey has nothing it is allowed to evict |
| `evicting`    | keys were evicted since the previous collection, `used_memory` is at least 90% of `maxmemory`, and LMCache holds at least half of `used_memory`   |

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

| Metric                       | OTel name                    | Labels                          | Description                                     |
| ---------------------------- | ---------------------------- | ------------------------------- | ----------------------------------------------- |
| `betterdb_kv_cache_hit_rate` | `betterdb.kv_cache.hit_rate` | `connection`, `engine`, `model` | LMCache token hit rate over the last 15 minutes |
| `betterdb_kv_cache_chunks`   | `betterdb.kv_cache.chunks`   | `connection`, `model`           | Estimated LMCache chunks stored                 |
| `betterdb_kv_cache_bytes`    | `betterdb.kv_cache.bytes`    | `connection`, `model`           | Estimated bytes held by LMCache keys            |

See [Prometheus Metrics](prometheus-metrics#kv-cache-metrics) for the full
reference. Hit-rate series exist only for enabled engines whose window has
requested tokens; they are removed when that stops being true. The `engine`
label is the engine name, which must be unique per connection.

## Configuration

| Variable                         | Default  | Description                                                                                    |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `KV_CACHE_FOOTPRINT_INTERVAL_MS` | `300000` | Footprint collection interval. An invalid value or one below `60000` falls back to the default |
| `KV_CACHE_SCAN_MAX_KEYS`         | `200000` | SCAN budget per collection. An invalid value or one below `1` falls back to the default        |
| `KV_CACHE_MATCH_MAX_KEYS`        | `2000`   | Matched-key cap per collection. An invalid value or one below `1` falls back to the default    |
| `KV_CACHE_SAMPLE_KEYS`           | `500`    | Keys sampled for size and TTL. An invalid value or one below `1` falls back to the default     |
| `KV_CACHE_SCRAPE_INTERVAL_MS`    | `30000`  | Engine scrape interval. An invalid or sub-second value falls back to the default               |
| `KV_CACHE_SCRAPE_BLOCK_PRIVATE`  | `false`  | `true` also refuses private and loopback scrape targets                                        |
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
