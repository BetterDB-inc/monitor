# Migration

BetterDB can migrate data between Valkey and Redis instances using a three-phase
workflow: **analysis**, **execution**, and **validation**. Each phase is
independent — you can run analysis without committing to a migration, and
validation is optional after execution completes.

## Phases

### 1. Analysis (Community tier)

Scans the source instance and compares it against the target to produce a
compatibility report. No data is written.

What it checks:

- **Key sampling** — SCAN + TYPE on a configurable sample (1,000–50,000 keys).
  In cluster mode each master node is sampled independently.
- **Memory estimation** — `MEMORY USAGE` per sampled key, extrapolated to the
  full keyspace.
- **TTL distribution** — Groups keys into buckets (no expiry, <1 h, <24 h,
  <7 d, >7 d).
- **Hash Field Expiry (HFE)** — Detects per-field TTLs on Valkey 8.1+ via
  `HEXPIRETIME`. Skipped on Redis or older Valkey.
- **Compatibility** — Produces a list of incompatibilities with severity levels
  (`blocking`, `warning`, `info`). See [Compatibility checks](#compatibility-checks).
- **Command distribution** — Top commands by frequency from `COMMANDLOG` (Valkey
  8+) or `SLOWLOG`.

### 2. Execution (Pro tier)

Transfers keys from source to target. Three modes are available:

| Mode | Mechanism | Best for |
|------|-----------|----------|
| **redis_shake** (default) | RedisShake `scan_reader` — DUMP/RESTORE via [redis-shake](https://github.com/tair-opensource/RedisShake) | Large datasets, same-engine migrations (Redis→Redis or Valkey→Valkey) |
| **redis_shake_sync** | RedisShake `sync_reader` — PSYNC-based continuous replication | Minimal-downtime migrations; keeps replicating until you cut over |
| **command** | In-process Node.js via iovalkey | Cross-engine migrations (Redis→Valkey), smaller datasets, easier debugging |

#### Choosing a mode

- **Same engine, same major version** (e.g. Redis 7→Redis 7, Valkey 7→Valkey 7): any mode works. `redis_shake` is fastest for large datasets.
- **Cross-engine** (Redis→Valkey or vice versa): use `redis_shake_sync` or `command`. The `redis_shake` (DUMP/RESTORE) mode will fail because Redis and Valkey use different RDB format versions and the `RESTORE` command rejects the foreign payload.
- **Near-zero downtime** required: use `redis_shake_sync`. It completes an initial snapshot and then keeps replicating incremental writes until you manually stop it.

#### Command mode

Connects directly to the source and target using the iovalkey library. For each
key it reads the value with a type-specific command, writes it to the target,
and preserves the TTL.

Supported data types:

| Type | Read | Write | TTL |
|------|------|-------|-----|
| string | `GET` (binary) | `SET PX` | Atomic — single `SET` with `PX` flag |
| hash | `HSCAN` (binary fields) | `HSET` to temp key, then `RENAME` | Lua `RENAME` + `PEXPIRE` |
| list | `LRANGE` in 1,000-element chunks | `RPUSH` to temp key, then `RENAME` | Lua `RENAME` + `PEXPIRE` |
| set | `SMEMBERS` or `SSCAN` (>10 K) | `SADD` to temp key, then `RENAME` | Lua `RENAME` + `PEXPIRE` |
| sorted set | `ZRANGE` or `ZSCAN` (>10 K) | `ZADD` to temp key, then `RENAME` | Lua `RENAME` + `PEXPIRE` |
| stream | `XRANGE` in 1,000-entry chunks | `XADD` to temp key, then `RENAME` | Lua `RENAME` + `PEXPIRE` |

Compound types (everything except string) are written to a temporary key first,
then atomically renamed to the final key. This avoids partial writes if the
process crashes mid-transfer. If `EVAL` is blocked by ACL on the target, the
rename and TTL are applied as separate commands with a small race window.

#### RedisShake mode (DUMP/RESTORE)

Spawns the redis-shake binary as a child process using its `scan_reader`. BetterDB
generates the TOML configuration, manages the process lifecycle, and streams
progress from its stdout. RedisShake scans every key on the source with `DUMP`,
sends the raw RDB payload to the target via `RESTORE`, and exits when the scan is
complete.

**RDB compatibility requirement**: `DUMP`/`RESTORE` payloads embed an RDB format
version byte. Redis and Valkey have diverged their RDB versions since the fork
(Redis 7.4 uses RDB v12; Valkey 7.x/8.x uses RDB v11). A `RESTORE` on the
receiving end will reject a payload with an unrecognised version. Use `command`
or `redis_shake_sync` mode for cross-engine migrations.

#### RedisShake sync mode (PSYNC)

Uses RedisShake's `sync_reader`, which opens a PSYNC replication stream from the
source — the same protocol a replica uses. This means:

1. **Initial RDB sync** — RedisShake requests a full sync, receives the source's
   RDB snapshot, and writes all keys to the target.
2. **Incremental AOF replication** — After the RDB transfer completes, the source
   keeps streaming every new write to RedisShake, which forwards it to the target
   in near real-time.

The migration **runs continuously** and never exits on its own. The UI shows a
stage chip that transitions from **Initial sync (RDB)** to
**Replicating · ready for cutover** once the snapshot phase finishes.

**Cutover procedure**:
1. Wait for the stage chip to show *Replicating · ready for cutover*.
2. Pause or quiesce writes on the source (brief read-only window).
3. Wait a few seconds for the replication lag to drain to zero (`diff=[0]` in
   the log).
4. Click **Stop Migration** in the execution panel.
5. Point your application at the target.

**Options**:

| Option | Default | Description |
|--------|---------|-------------|
| `preferReplica` | `false` | Read from a replica instead of the primary. Recommended for production clusters — avoids placing extra PSYNC load on the primary. |

`sync_rdb` and `sync_aof` are hardcoded to `true`. Snapshot-only or AOF-only
modes may be exposed in a future release.

**Known limitation — log parsing**: sync_reader emits different log keys than
scan_reader (`write_count`, `diff`, `syncing aof`). Progress during the initial
RDB phase is not available; the progress bar remains hidden until the AOF
replication stage begins.

#### Binary location (all RedisShake modes)

The binary is found in this order:
1. `$REDIS_SHAKE_PATH` environment variable
2. `/usr/local/bin/redis-shake` (Docker image)
3. `~/.betterdb/bin/redis-shake` (npx install)

### 3. Validation (Pro tier)

Spot-checks the target after migration to verify data integrity.

Steps:

1. **Key count** — `DBSIZE` on both sides. Computes discrepancy percentage.
2. **Sample validation** — SCAN ~500 random keys and compare type + value.
   Large keys (>100 elements) are compared by element count only to avoid
   timeouts.
3. **Baseline comparison** (optional) — If a migration start time is provided
   and BetterDB has >= 5 pre-migration memory snapshots, compares opsPerSec,
   usedMemory, fragmentation ratio, and CPU usage against the pre-migration
   baseline.

A validation **passes** when the issue count is 0 and the key count discrepancy
is below 1%.

## Topology support

| Source | Target | Status | Notes |
|--------|--------|--------|-------|
| Standalone | Standalone | Supported | Direct key transfer |
| Standalone | Cluster | Supported | Keys are resharded across target slots. Analysis reports a warning. |
| Cluster | Cluster | Supported | Per-master scanning, slot-aware writes |
| Cluster | Standalone | **Blocked** | Analysis reports a blocking incompatibility. The data is spread across slots and cannot be safely collapsed into a single node. |

## Compatibility checks

Analysis detects the following incompatibilities:

| Category | Severity | Condition |
|----------|----------|-----------|
| `cluster_topology` | blocking | Cluster source, standalone target |
| `cluster_topology` | warning | Standalone source, cluster target (keys will be resharded) |
| `type_direction` | blocking | Valkey source, Redis target (Valkey-specific features may be lost) |
| `hfe` | blocking | Hash Field Expiry detected on source, target does not support it |
| `modules` | blocking | Source uses a module not present on target (one entry per module) |
| `multi_db` | blocking | Source uses multiple databases and target is a cluster (clusters only support db0) |
| `multi_db` | warning | Source uses multiple databases, target is standalone but may not be configured for it |
| `maxmemory_policy` | warning | Eviction policy differs between source and target |
| `acl` | warning | Source has custom ACL users that do not exist on target |
| `persistence` | info | Persistence configuration differs |

Blocking incompatibilities are advisory — the execution endpoint does not
currently enforce them. A future release will reject execution when blocking
incompatibilities exist.

## Limitations

### Keys containing `{` (hash tags in cluster mode)

In cluster mode, Valkey determines which slot a key belongs to by hashing the
substring between the first `{` and the next `}`. This is called a **hash tag**.

During command-mode migration, compound types are written to a temporary key and
then renamed to the final key. `RENAME` requires both keys to hash to the same
slot. To satisfy this, the temp key reuses the original key's hash tag:

```
Original key:   user:{12345}:profile
Temp key:       __betterdb_mig_a1b2c3d4:{12345}

Original key:   plain-key-no-braces
Temp key:       __betterdb_mig_a1b2c3d4:{plain-key-no-braces}
```

**Edge case**: If a key contains `{` but no matching `}`, or the content between
the braces is empty (e.g., `foo{}bar`), Valkey hashes the entire key. BetterDB
handles this correctly — the `tempKey()` function only extracts a hash tag when
`{...}` contains at least one character. Otherwise it wraps the full key name as
the tag.

**Impact on key names with literal braces**: If your keys use `{` as part of
their name rather than as a hash tag (e.g., `json:{data}`), the migration still
works correctly. The content between the first `{…}` pair is reused as the tag,
which guarantees the temp key lands in the same slot. The key's value and name
are preserved exactly.

### Binary data

All migrations use `*Buffer` variants of commands (`getBuffer`, `lrangeBuffer`,
`hscanBuffer`, etc.) so binary values are never coerced to UTF-8. Hash field
names are read via `HSCAN` (not `HGETALL`) specifically because `hgetallBuffer`
coerces field names to strings.

**RedisShake mode**: The TOML configuration builder rejects values (passwords,
connection strings) containing control characters (`\x00–\x08`, `\x0b`, `\x0c`,
`\x0e–\x1f`, `\x7f`) to prevent TOML injection.

### TTL precision and race conditions

- **String keys**: TTL is applied atomically via `SET key value PX pttl` — no
  window where the key exists without its TTL.
- **Compound types**: A Lua script performs `RENAME` + `PEXPIRE` in a single
  `EVAL` call. If the target blocks `EVAL` via ACL, BetterDB falls back to
  separate `RENAME` and `PEXPIRE` commands. In this fallback path there is a
  brief window where the key exists with no expiry.
- **Expired between read and TTL fetch**: If `PTTL` returns `-2` (key expired),
  the target copy is deleted.

### Hash Field Expiry (HFE)

Valkey 8.1+ supports per-field TTLs within a hash. Analysis detects HFE usage
via `HEXPIRETIME`, but **command-mode migration does not transfer per-field
expirations**. Only the overall key-level TTL is preserved. If the target does
not support HFE, analysis flags this as a blocking incompatibility.

### Large keys

Keys with more than 10,000 elements use cursor-based reads (`HSCAN`, `SSCAN`,
`ZSCAN`) instead of bulk commands to avoid blocking the server. Lists and
streams are always read in 1,000-element chunks regardless of size.

During validation, keys with more than 100 elements are compared by **element
count only** — full value comparison is skipped to avoid timeouts.

### Multi-database

Command-mode migration and cluster mode only operate on database 0. If the
source uses multiple databases (`db0`, `db1`, etc.) and the target is a cluster,
analysis flags this as a blocking incompatibility. For standalone targets,
analysis issues a warning.

### ACL users and modules

ACL rules and loaded modules are **not migrated** — they are analyzed and
reported. If the source has custom ACL users missing from the target, analysis
issues a warning. If the source uses modules not loaded on the target, analysis
flags a blocking incompatibility.

### DBSIZE accuracy in cluster mode

`DBSIZE` on a cluster client is sent to a single random node, returning a
partial count. This means the key count comparison in validation may be
inaccurate for cluster targets. This is a known limitation.

### Concurrent writes on the source

**Command and redis_shake (DUMP/RESTORE) modes** read a point-in-time snapshot
per key but do not freeze the source. If keys are modified on the source during
migration:

- **Lists** may have different lengths. A post-migration length check warns if
  the list grew or shrank.
- **Keys created after SCAN started** are missed entirely.
- **Keys deleted after SCAN** are skipped with no error (the read returns nil).

For a consistent migration with these modes, quiesce writes to the source before
starting.

**redis_shake_sync mode** is specifically designed for live sources. It replicates
writes continuously via PSYNC, so keys created or modified after the initial RDB
sync are captured. The intended workflow is to keep the source running normally,
wait for the stage to show *Replicating · ready for cutover*, then apply a brief
read-only window only at the moment of cutover.

### RDB format compatibility

`DUMP`/`RESTORE` transfers (used by `redis_shake` scan mode) embed an RDB version
byte in the payload. The target's `RESTORE` command rejects payloads with a
version it does not understand.

| Source engine | Target engine | redis_shake | redis_shake_sync | command |
|---------------|---------------|:-----------:|:----------------:|:-------:|
| Redis 7.x | Redis 7.x | ✅ | ✅ | ✅ |
| Valkey 7.x | Valkey 7.x | ✅ | ✅ | ✅ |
| Redis 7.4+ | Valkey any | ❌ RDB v12 vs v11 | ✅ | ✅ |
| Valkey any | Redis 7.4+ | ❌ RDB v11 vs v12 | ✅ | ✅ |

`redis_shake_sync` is not affected because RedisShake parses the RDB stream
internally and writes to the target using application-level commands, bypassing
the `RESTORE` compatibility constraint entirely.

## Batching and concurrency

| Parameter | Value |
|-----------|-------|
| SCAN batch size | 500 keys per iteration |
| TYPE lookup batch | 500 keys per pipeline |
| Migration batch | 50 keys in parallel |
| List/stream chunk | 1,000 elements per read |
| Max concurrent analysis jobs | 20 |
| Max concurrent execution jobs | 10 |
| Stuck job timeout | 2 hours (auto-cancelled) |

## Credential handling

RedisShake log output is sanitized before being served to the frontend. Patterns
like `password = "secret"` and `redis://user:pass@host` are redacted. Source
passwords are never included in API responses.
