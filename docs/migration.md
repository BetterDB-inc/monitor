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
- **Near-zero downtime** required: use `redis_shake_sync`. It completes an initial snapshot and then keeps replicating incremental writes until you complete the cutover (or stop it).

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
| stream | `XRANGE` in 1,000-entry chunks, plus `XINFO` / `XPENDING` for groups | `XADD`, `XSETID`, `XGROUP CREATE`, `XCLAIM … FORCE` to temp key, then `RENAME` | Lua `RENAME` + `PEXPIRE` |

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
stage chip that transitions from **Initial sync (RDB)** to **Replicating** once
the snapshot phase finishes. Next to the chip, a lag readout shows how far
RedisShake is behind the source on the slowest shard; click it for a per-shard
breakdown. BetterDB reads this from RedisShake's status endpoint (`status_port`,
a free local port chosen per run) once a second. Lag is the replication-stream
bytes RedisShake has received from a shard but not yet handed to its writer,
so it is not the same as "written to the target". A shard shows *initial sync*
until its first replicated command has been processed, which on an idle source
can take a few seconds after the snapshot.

The chip turns **Fully synced** only when RedisShake itself reports the run as
consistent on two polls in a row: every shard has handed off everything it
received, its internal queue is empty, and the target has acknowledged every
write sent to it. A command in transit between RedisShake's reader and writer
is not counted for that instant, which is why two polls in a row are required.
If the status endpoint stops answering, the readout is marked
as not updated recently and the chip drops back to *Replicating*.

RedisShake reads the source topology once, at start. A shard added or resharded
to a new master during the migration is not replicated; restart the migration
after a topology change.

The status endpoint listens on all interfaces of the host running RedisShake and
reports source and target addresses (no credentials). In a container it is
reachable only if you publish that port.

**Cutover procedure**:
1. Wait for the stage chip to show *Replicating* or *Fully synced*.
2. Pause or quiesce writes on the source (brief read-only window).
3. Click **Complete cutover** in the execution panel and confirm. The job shows
   *Completing* and waits until RedisShake stays *Fully synced* for a few
   seconds (default limit: 5 minutes), then stops RedisShake.
4. When the job shows *Completed* ("Cutover complete at …"), point your
   application at the target.

*Fully synced* cannot detect writes that are still arriving: under a steady
write load RedisShake can briefly report itself consistent while writes
continue, and anything written to the source after the cutover is lost. Pausing
writes in step 2 is what makes the cutover safe; the check only confirms that
RedisShake has caught up.
RedisShake is given up to 60 seconds after the stop to finish writing to the
target; if it exits with an error or has to be killed, the cutover ends as
*Failed* rather than *Completed*.

**If the cutover times out**: RedisShake did not stay *Fully synced*, so the
migration goes back to *Replicating* and keeps running. Pause writes and
click **Retry cutover**, or click **Force cutover** to end the migration now.
A forced cutover finishes as *Completed* and records the per-shard lag you
accepted; those writes may be missing on the target.

**Stop Migration** cancels the migration without a cutover and ends as
*Cancelled*, at any point, including while a cutover is waiting. Once the
cutover has started stopping RedisShake (after *Fully synced* held, or after a
forced cutover), it can no longer be cancelled: Stop returns `409` and the
migration finishes as a cutover.

The same actions are available over the API:
`POST /migration/execution/:id/complete` with an optional body
`{ "force": boolean, "timeoutSeconds": number }` (`timeoutSeconds` is an integer
from 10 to 3600, default 300). It returns `409` unless the job is a
`redis_shake_sync` migration that is replicating or already completing.
`DELETE /migration/execution/:id` cancels.

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

#### Shutdown and restarts (all modes)

Stopping BetterDB (SIGTERM, `docker stop`, Ctrl-C on the CLI) stops every running
migration the way **Stop Migration** does: RedisShake gets SIGTERM, then SIGKILL if
it is still running 3 seconds later, and command-mode migrations stop at their next
batch. Migrations do not resume after a restart; start them again.

Each RedisShake run writes its configuration, including the source and target
credentials, to `<tmpdir>/<job id>.toml` (mode `0600`) and removes it when the run
ends. If BetterDB is killed before it can clean up (SIGKILL, out of memory), the
next start removes those files once their RedisShake process is gone, and logs a
warning for any whose process is still running. Because that check relies on the
PID file, a RedisShake run whose PID file cannot be written is stopped straight
away and the migration fails with an error, rather than running untracked.

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

### Other engines

BetterDB detects the engine from `INFO server`: a `valkey_version` field means
`valkey`, anything else is `redis`. Redis and Valkey are what the migration
test suite covers. Other RESP-compatible engines are reachable because the
three modes only need standard commands, but each mode has a protocol
requirement the engine has to meet, and neither KeyDB nor Dragonfly is
exercised by the tests. The rows below come from the engines' source and
docs, not from a test run.

| Engine | Detected as | `redis_shake_sync` | `redis_shake` | `command` | Notes |
|--------|-------------|:------------------:|:-------------:|:---------:|-------|
| Redis 7.x, Valkey 7.x/8.x | `redis` / `valkey` | ✅ | ✅ (same RDB version) | ✅ | Tested. See [RDB format compatibility](#rdb-format-compatibility). |
| Redis < 7 | `redis` | ✅ | ✅ as source (RDB v9/v10 restores on newer targets); ❌ as target from a 7.x source | ✅ | Analysis probes `INFO` section by section because these engines reject the multi-section form. |
| KeyDB | `redis` | ✅ as source (Redis 6.2 fork, serves `PSYNC`) | ✅ as source (RDB v9); ❌ as target from a 7.x source | ✅ | Same `INFO` handling as Redis < 7. Keys of KeyDB's own `CRON` type have no equivalent on the target. Untested. |
| Dragonfly | `redis` (reports `redis_version 7.4.0`) | ❌ as source: Dragonfly implements `REPLICAOF`, `REPLCONF` and `ROLE` but not `PSYNC` or `SYNC`, so nothing can attach to it as a Redis-protocol replica. ✅ as target | Untested in either direction. Dragonfly's `RESTORE` rejects payloads newer than the RDB version it implements, and the analysis RDB check treats it as Redis, so it will not warn you. | ✅ | `command` mode is the dependable path out of Dragonfly. Untested. |

### Managed providers

Managed services are supported on either side as long as BetterDB can reach
them (see the [provider guides](providers/)). Two constraints follow from the
mechanisms above:

- **`redis_shake_sync` needs a replica connection to the source.** Managed
  providers commonly restrict `PSYNC` and `SYNC` (AWS does on every ElastiCache
  and MemoryDB cache). A managed source that restricts them can only be
  migrated with `redis_shake` (DUMP/RESTORE, same RDB version) or `command`
  mode, and only where the provider guide lists that mode for that direction.
  Both read a point-in-time copy per key, so quiesce writes on the source for a
  consistent result. A managed source that permits the replication commands
  can use `redis_shake_sync` as usual.
- **`redis_shake` (DUMP/RESTORE) needs matching RDB versions.** Managed
  providers do not always run the engine version their name suggests, so for
  a managed target prefer `redis_shake_sync` or `command`.
- **Execution and validation connect to the stored host and port directly.**
  They do not go through the BetterDB Agent or an SSH tunnel; an agent
  connection has no addressable endpoint and a tunnelled connection is reached
  at its remote address. Those connection types support monitoring and the
  analysis phase only. To execute a migration involving a VPC-only cache, run
  BetterDB Monitor on a host that can reach both caches directly, for example
  self-hosted on an EC2 instance in the same VPC.

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
| `capacity` | blocking | A target master cannot evict (`noeviction`; or `volatile-*` with no TTL keys in the source, and either none on the master or the source share alone exceeds `maxmemory` by >10%) and its share of the source exceeds the room it would have after emptying the target by more than 10% |
| `capacity` | warning | A non-evicting master's share fits only once the target is emptied (`emptyDbBeforeSync` or `FLUSHALL`); or is within 10% of the room after emptying (too close to call); or the master evicts (`allkeys-*`, `volatile-*` with TTL keys); or it fits with under 10% headroom; or a blocker whose source size is only the source's `used_memory` (`MEMORY USAGE` unavailable) |
| `capacity` | info | The capacity and key-overlap checks could not run (for example NOPERM on `INFO`, or an unreachable master) |
| `key_overlap` | warning | Sampled source keys (up to 200, spread across source nodes) already exist in the target's db0 (command mode overwrites them; RedisShake modes stop with `BUSYKEY` unless the target is flushed first) |
| `key_overlap` | warning | **Target keys outside db0 (RedisShake modes):** RedisShake copies every db into the same db index on the target, and `emptyDbBeforeSync` runs `FLUSHALL`. When the target holds keys outside db0, analysis warns for the RedisShake modes, names each db and its key count, and says whether the source uses the same db (keys that already exist there stop RedisShake with `BUSYKEY`). Command mode writes only db0 and is not affected. These dbs are counted, not sampled, so this is always a warning |
| `key_overlap` | info | The target's db0 already holds keys and none of the sampled source keys collide; or no source keys were sampled; or the overlap check could not run (e.g. `EXISTS` denied) |

The capacity check runs per target master. The source size is the analysis
estimate (sampled `MEMORY USAGE` scaled to the key count) restricted to db0's
share of the source's keys, since command mode copies db0. When a standalone
source also has keys outside db0, the check runs a second time for the
RedisShake modes, which copy every db, sized by the source's
`used_memory_dataset` and its TTL keys in every db. Each of those results is
labelled "(command mode)" or "(RedisShake modes)" and only blocks execution in
the modes it names. The execution page counts blockers for the mode you select,
and the analysis verdict notes which modes a scoped blocker leaves free. Each master's share
of it is weighted by the hash slots it owns, or split equally when the slot map
is unavailable, and compared with the master's free memory: `maxmemory -
(used_memory - mem_not_counted_for_evict)`, the figure Valkey uses to decide
when to evict or reject writes. Each master is judged by its own
`maxmemory-policy`; masters without `maxmemory` are skipped, while capped
masters in the same cluster are still checked.

- **Overriding a blocker:** when the selected mode has blocking issues, the confirm dialog lists them and asks for a reason; starting sends `force` and `forceReason`, which the server records. Without blockers for that mode nothing changes.
- **Non-default source db:** if the source connection selects a db other than db0 (standalone), analysis samples that db while command mode copies db0, so the capacity and key-overlap checks are skipped with an info item.
- **Cluster estimates:** each master's share assumes keys are spread evenly across its hash slots; hash tags can put more data on one shard. If the slot map can't be matched to the masters, an equal split is assumed and the finding says so. Masters that can't be read are listed, and capacity is checked on the rest.
- **Unknown eviction policy:** a target that doesn't report `maxmemory_policy` (some proxies and managed services) is never blocked on capacity; findings are warnings.
- **Sampled overlap:** up to 200 db0 source keys are checked. That reliably detects an overlap rate above about 1.5%; lower rates can still exist, and RedisShake stops at the first `BUSYKEY`.

A master that cannot evict is also judged against the room it would have after
emptying the target: `emptyDbBeforeSync` runs `FLUSHALL` on every master, which
frees `used_memory_dataset` in every db, never the baseline. If the share fits there, the analysis warns to empty the target first;
it blocks only when the share exceeds that room by more than 10%, because the
source size is a sampled estimate. When sampling is unavailable the source's
`used_memory` is used instead, which includes buffers and overhead, so it
produces a warning rather than a block. The analysis reports the master with the
least room and how many masters were flagged. Slot weighting assumes keys are
spread evenly across slots, so heavy hash tags or a few very large keys can
still overload one shard; leave headroom in that case.

Execution is refused while the latest analysis for the pair has blocking
incompatibilities that apply to the requested mode, unless the request sets
`force: true` with a `forceReason`.

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

### Streams and consumer groups

Command mode copies a stream's consumer groups along with its entries: each
group's last-delivered ID and entries-read counter, its consumers, and its
pending entries (owner, idle time and delivery count, recreated with
`XCLAIM … FORCE JUSTID`). The stream's last-generated ID, entries-added and
max-deleted-entry ID are restored with `XSETID`, so new IDs on the target never
go backwards. Streams that are empty but still hold groups are migrated too.

A pending entry whose message is not in the copy cannot be recreated: the
message was trimmed or deleted on the source, or was added and delivered after
the entries were copied (group state is read after the entries, so on a live
source this can happen). The migration log lists a `WARN` line with the count
for that key. On targets older than 7.0, `XSETID` and `XGROUP CREATE` run without
the 7.0-only counters.

Validation compares each stream's group names and last-delivered IDs as well as
its length.

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

### Key counts and samples in cluster mode

Validation sums `DBSIZE` over every master of a cluster source or target, so
the key count comparison covers the whole dataset. The sample spot-check also
covers every master of a cluster source: the ~500-key budget is split across
masters in proportion to their `DBSIZE`, and every master that holds keys gets
at least one sample as long as the budget is at least the number of non-empty
masters (above ~500 masters, the smallest shards may get none). A shard whose
keys never reached the target therefore shows up as missing keys rather than
passing unnoticed. Keys are found with a per-master `SCAN`, but `TYPE` and
values are read through the cluster client, so a slot migration or failover
during validation is followed rather than reported as missing keys.

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
wait for the stage to show *Replicating*, then apply a brief read-only window
only at the moment of cutover and click **Complete cutover**.

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

### SSH tunnels

Connections reached through an SSH tunnel cannot be migrated yet. Analysis,
execution and validation reject them with a 400 before doing anything, and the
connection picker marks them as unavailable. Execution and validation open their
own connections to `host:port` (and RedisShake runs as a separate process), so
they would bypass the tunnel and fail partway through — in the worst case after
an `emptyDbBeforeSync` flush has already emptied the target. To migrate such an
instance, register a connection BetterDB can reach directly, for example through
a VPN or a port-forward you run yourself.

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
