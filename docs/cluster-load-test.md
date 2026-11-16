---
title: Cluster Load Test
nav_order: 3.9
---

# Cluster Load Test

How much does it cost to monitor a large cluster? This page describes the load
test that answers that question.

The test needs no Docker and no real cluster. It starts a fake cluster of any
size on local ports, boots the real BetterDB API against it and measures what
the pollers send and how long they take.

## What it starts

- **A fake cluster.** One listening port per node, in a separate process. Each
  node answers the commands the pollers send (`INFO`, `CLUSTER NODES`,
  `CLUSTER SHARDS`, `CLUSTER SLOT-STATS`, `CLIENT LIST`, `SLOWLOG`, `CONFIG GET`
  and so on). It counts every command and every byte, per node. It can also
  make a node hang (the socket stays open, nothing is answered), promote a
  replica and hold every reply back by a fixed delay.
- **The API.** The real application, pointed at the first node. Every poller
  runs its real code on its normal interval. Three things around it are stand-ins:
  storage is the in-memory adapter, the cluster is the fake one, and the license
  server is a local stand-in that answers "Pro" (see below).

### License

Large clusters are run by paying customers, so by default the test runs with
the Pro features switched on. It does that without a real license: a local
stand-in for the license server answers every check with the Pro tier, and the
API is started with a placeholder key and `LICENSE_ALLOW_UNSIGNED=true`.
`--license community` runs without a license instead, and `--license enterprise`
answers with the Enterprise tier.

Work that only runs with a license: Key Analytics, the KV cache footprint and
scrape collectors with their alerts, the inference SLA checks, the scaling
readiness history, and the Pro and Enterprise webhook events. The anomaly
detectors, latency regression and the config monitor run on every tier.

### Reply profile

`--profile` decides how much the fake nodes have to say:

| Reply | `realistic` (default) | `empty` |
|---|---|---|
| `CLIENT LIST` | 200 clients plus BetterDB's own | 20 clients plus BetterDB's own |
| `SLOWLOG GET`, `COMMANDLOG GET` | 128 entries, one new entry every 10 s | empty |
| `LATENCY LATEST`, `LATENCY HISTORY` | 4 events, 60 samples each, all from before the start, no new spikes | empty |
| `INFO commandstats`, `INFO latencystats` | 60 commands | 11 commands |
| Keyspace (`SCAN`, `TYPE`, `MEMORY USAGE`, `OBJECT`, `TTL`) | at least 20,000 string keys per node | no keys |

Every table of results says which license, profile and reply delay it used.

## What it measures

Over a fixed window, after a warm-up:

| Figure | Meaning |
|---|---|
| Commands/s | Commands the whole cluster received from BetterDB |
| KB/s received | Reply bytes BetterDB had to read and parse |
| Busiest node cmd/s | Load on the single node that got the most commands |
| Connections up / registered / expected | BetterDB connections that are up, that exist, and that the setup should have |
| Sockets | Open connections from BetterDB to the cluster |
| Poll time | How long one pass of a poller takes, p50 and p95 |
| Ticks done / expected | Whether a poller keeps up with its own interval |
| Commands per tick | Commands one pass of a poller sends |
| CPU, heap, RSS peak | Cost inside the BetterDB process. RSS is the highest value seen in the window |
| Loop delay | How late the BetterDB event loop ran, p99, above the 10 ms sampling interval |
| Ports held | Open sockets plus the ports that closed connections still hold |
| Fake cluster CPU and loop delay | Load on the fake cluster itself, to tell a slow fake from a slow monitor |
| Events | Webhook events raised in the window, by type |

Two setups are run for each size:

- **Seed only.** One registered connection. BetterDB reaches the other nodes
  through cluster discovery.
- **Every node.** [Cluster auto-registration](cluster-auto-registration.md) is
  on, so every node becomes its own connection.

## Running it

From `apps/api`:

```bash
pnpm load:cluster
```

That runs 100, 250 and 500 nodes in both setups and prints one summary table
plus, for each run, the commands and the pollers that cost the most. One size
at a time:

```bash
pnpm load:cluster --nodes 500 --modes seed
```

| Option | Default | Meaning |
|---|---|---|
| `--nodes 100,250,500` | `100,250,500` | Cluster sizes, each a multiple of replicas + 1 |
| `--modes seed,auto` | both | `seed` = one connection, `auto` = every node registered |
| `--replicas 1` | `1` | Replicas per shard |
| `--warmup 30` | `30` | Seconds before measuring starts |
| `--measure 120` | `120` | Seconds measured |
| `--settle 300` | `300` | Longest wait for auto-registration to finish, seconds |
| `--hang 2` | `0` | Nodes that stop answering when the window starts, fewer than the cluster size |
| `--failover` | off | Promote a replica of shard 1 halfway through the window; needs two shards and a replica |
| `--license pro` | `pro` | `pro` or `enterprise` = licensed features on, `community` = no license |
| `--profile realistic` | `realistic` | `realistic` or `empty` replies, see above |
| `--reply-delay-ms 1` | `0` | Hold every reply back this long, to stand in for a network |
| `--out <dir>` | none | Also write one JSON file per run, failed and skipped runs included, and `report.md` |
| `--force` | off | Run a size even when it does not fit the local port range |

## Local ports

Every connection from the API to a fake node takes one local port, and the
whole test runs on one loopback address.

| Setup | Ports needed | 100 nodes | 250 nodes | 500 nodes |
|---|---|---|---|---|
| Seed only | about one per node | 100 | 250 | 500 |
| Every node | up to nodes x nodes | 10,000 | 62,500 | 250,000 |

macOS has 16,384 local ports for the whole machine. A run that would take more
than half of the local port range is skipped with a message; `--force` runs it
anyway. A run that does run out of ports is stopped and listed as invalid
instead of printing numbers. So on macOS the "every node" setup can only be
measured for small clusters.

A closed connection keeps its local port for a while: about 30 seconds on
macOS, 60 on Linux, 120 on Windows. A run that opens and closes many
connections can therefore use far more ports than it has sockets open. The
**Ports held** column counts both, using the time of the system the test runs
on, and a run is marked suspect when that number passes half of the local port
range.

## When a run is not trusted

- **Suspect.** The numbers are printed, with the reason below the table. A run
  is suspect when the fake cluster's own event loop ran more than 20 ms late at
  p99 (slow replies may then come from the fake, not from BetterDB), or when
  the ports held pass half of the local port range.
- **No numbers.** The run is listed with its reason and left out of the tables.
  That happens when it ran out of local ports, when not every node was
  registered before the settle time ran out, when more registered connections
  were down at the end of the window than nodes were made to hang, when the
  license did not come up as asked, when the run did not finish in time, or
  when it crashed. A crash is listed with its signal and error line, so a run
  that ran out of memory reads "killed by SIGABRT" with the heap limit message.

## Reading the output

- **Ticks done / expected** below the expected count does not always mean a
  poller skipped work. A poller starts its next pass one interval after the
  previous one ended, so a pass that takes 150 ms on a 1 s interval gives about
  104 passes in two minutes, not 120.
- **KB/s received** is dominated by `CLUSTER NODES` on large clusters. Its
  reply grows with the number of nodes, and so does the number of nodes it is
  read from.
- **CLUSTER NODES sent by** names the poller and the function that sent each
  read, so the cost of the cluster map can be traced to its callers.
- **Commands per poller** are counted inside BetterDB; the totals at the top
  are counted by the fake cluster and are the ones to trust. A poller is
  charged for everything that starts inside one of its passes. That includes
  the handshake and the reconnects of a node connection the pass happened to
  open, even when other pollers use that connection later. Work that does not
  start in a poller pass (the health check of the connection registry, cluster
  discovery, requests) is listed as "background".
- **Pollers with a long interval** only show up when a pass falls inside the
  window. Key Analytics runs once at start and then every 5 minutes, so the
  default 120 second window never contains a pass; use `--measure 330` or more
  to see it. One pass reads 10,000 keys per connection, about 40,000 commands.
- **Events** lists what would have been sent to webhooks. `cluster.failover`
  is counted before the license check, so it shows up with any license. With
  the realistic profile the growing slow log can raise a slow-query anomaly.
- **Reply delay.** Without `--reply-delay-ms` a reply comes back in well under
  a millisecond, which is faster than any real network. Reads that go to one
  node after another look cheaper than they are across zones. Rows measured
  with a delay say so in the "Reply delay ms" column.
- **Loop delay** is reported above the 10 ms sampling interval. Figures taken
  before the test subtracted that interval are 10 ms higher and cannot be
  compared with the ones printed now.
- Run it on a quiet machine. The API and the fake cluster each use one CPU
  core; other load on the machine changes the poll times.
- The test removes its temporary data directory when a run ends. A run that
  is killed for running out of time leaves one behind in the system's
  temporary folder, named `betterdb-cluster-load-`.

## Results

Measured on 2026-11-16 with version 0.55.0 on an 18-core Mac, one run at a
time, with the defaults: 120 second window, 30 second warm-up, one replica per
shard, Pro license, realistic replies, no reply delay.

MB is 10^6 bytes and KB is 10^3 bytes, worked out from the byte counts in the
JSON files. The KB/s columns the test prints divide by 1,024.

A poller starts its next pass one interval after the previous one ended. The
number of passes in the window is therefore about 120 s / (interval + pass
time). Fewer passes mean the cluster is sampled less often, not that work was
skipped.

### One registered connection

| Nodes | Sockets | Commands/s | Replies MB/s | Anomaly pass p50 / p95 ms | Anomaly passes | Loop delay p99 ms | CPU % | Heap MB | RSS peak MB |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 101 | 368 | 5.1 | 86 / 105 | 111 | 22 | 11 | 149 | 588 |
| 250 | 251 | 526 | 9.6 | 138 / 164 | 105 | 32 | 16 | 158 | 659 |
| 500 | 501 | 698 | 22.0 | 221 / 299 | 98 | 68 | 23 | 160 | 721 |

The fake cluster used 1.3 to 2.4 % CPU and ran at most 1.4 ms late at p99, so
it was not the limit. The command count inside BetterDB equals the count of the
fake cluster in all three runs.

`CLUSTER NODES` reads per second, by caller:

| Caller | 100 nodes | 250 nodes | 500 nodes |
|---|---|---|---|
| Replica slot check | 46.3 | 110.4 | 202.1 |
| Fan-out to unregistered primaries | 22.8 | 28.6 | 26.4 |
| Slot migration read | 1.7 | 4.2 | 41.7 (8.3 without the effect below) |
| The connection's own poll | 0.9 | 0.9 | 0.8 |
| Prometheus | 0.2 | 0.2 | 0.2 |
| Total | 71.9 | 144.3 | 271.2 |
| Reply size of one read, KB | 12.6 | 31.6 | 63.5 |
| Replies for the map, MB/s | 0.9 | 4.6 | 17.2 |

- At 500 nodes the cluster map is 17.2 of the 22.0 MB/s of replies, and the
  replica slot check sends 75 % of the reads.
- The fan-out stays level from 250 nodes on. It is held by its limit of 64
  primaries per pass.
- The slot migration figure at 500 nodes is an effect of the fake cluster. The
  fake gives the last shard the slots left over from the division: 199 slots
  against 65 with 250 shards, so its slot statistics are three times the
  median and BetterDB raises a hot shard alert. With that alert open the slot
  migration state is read again on later passes, from every primary each time.
  The fake answered every `CLUSTER GETSLOTMIGRATIONS` with an empty list and no
  slot migration alert was raised. Without the hot shard the read runs every
  30 seconds: 250 primaries / 30 s, about 8.3 reads per second, and a total of
  about 238. The cause was read from the code and the run's output, not
  measured in a second run.

### Every node registered

| Nodes | Sockets | Ports held | Commands/s | Replies MB/s | Anomaly pass p50 / p95 ms | Anomaly passes | Loop delay p99 ms | CPU % | RSS peak MB | `CLUSTER NODES`/s | Warnings |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 30 | 930 | 1,102 | 618 | 3.9 | 89 / 115 | 110 | 19 | 12 | 841 | 434 | 78 |
| 50 | 2,549 | 2,985 | 1,344 | 10.0 | 237 / 328 | 96 | 74 | 24 | 1,042 | 1,033 | 2,882 |
| 80 | 6,479 | 7,479 | 2,448 | 24.4 | 677 / 796 | 71 | 303 | 46 | 1,337 | 1,937 | 6,939 |
| 100 (suspect) | 10,099 | 11,575 | 2,931 | 34.2 | 1,221 / 1,565 | 54 | 652 | 60 | 1,645 | 2,296 | 10,559 |

- Sockets are nodes x nodes + nodes at every size.
- From 50 nodes the limit of 512 pooled node connections is reached all the
  time ("Connection limit reached", "Closing oldest connection"), and it does
  not keep the socket count down: 2,549 open sockets at 50 nodes, about 50 of
  them the registered connections' own. The test counts open sockets, not the
  entries of the pool.
- The replica slot check sends 92 to 97 % of the `CLUSTER NODES` reads: 399,
  980, 1,870 and 2,228 per second.
- `connection.spike` events in the window: 15, 25, 40 and 50.
- At 100 nodes one anomaly pass takes 1.2 to 1.6 s, so the cluster is sampled
  about every 2.2 s instead of every 1.1 s. 5,505 connections were opened in
  the window, and the run raised 99 `cpu_utilization` anomalies although the
  fake's CPU counters grow at a constant rate.
- The 100-node run is suspect for local ports only: 11,575 of 16,384 were
  held, and it was run with `--force`. All 100 connections were up at the end.
- 250 and 500 nodes with every node registered need 62,500 and 250,000 local
  ports and were not run.

### Failover

One replica promoted halfway through the window:

| Run | `cluster.failover` events | Other |
|---|---|---|
| 100 nodes, one connection | 1 | Pass time unchanged (92 / 110 ms) |
| 30 nodes, every node registered | 30 | Plus one `failover.started` and one `failover.completed` |

One failover gives one event per registered connection.

### Hung nodes

Two nodes accept TCP and stop replying (`--hang 2`):

| Run | Anomaly pass p50 / p95 ms | Anomaly passes | Prometheus pass p50 / p95 ms | Commands/s |
|---|---|---|---|---|
| 100 nodes, one connection | 4,014 / 9,033 | 24 | 31 / 4,009 | 94 (368 without) |
| 30 nodes, every node registered | 5,001 / 7,026 | 19 | 5,001 / 5,002 | 116 (618 without) |

- Two silent nodes stretch one anomaly pass to 4 to 9 s, so the whole cluster
  is sampled every 5 to 6 s instead of about every 1.1 s.
- With every node registered the two hung connections were still listed as
  connected at the end of the window and no `instance.down` was dispatched.
  The log has 38 "Failed to poll metrics" errors and 51 "still running,
  skipping" warnings.

## Limits of the method

- Storage is the in-memory adapter. Write cost and query cost of SQLite or
  PostgreSQL are not measured, and Key Analytics sends its commands but cannot
  store the result.
- No webhooks are configured. Events are counted, nothing is delivered.
- The CVE advisory refresh is the one part that still leaves the machine: it
  asks its public sources when the machine is online.
- There is no network: no delay unless `--reply-delay-ms` is set, no packet
  loss, no TLS, no authentication.
- Every primary owns one contiguous slot range. Fragmented slot maps, which
  make `CLUSTER NODES` and `CLUSTER SHARDS` replies larger, are not covered.
- The last shard takes the slots left over from the division, so it can own
  far more slots than the others: 199 against 65 with 250 shards. Its slot
  statistics are higher by the same factor, which raises a hot shard alert at
  that size.
- A failover is always clean: the replica is promoted at once and every node
  agrees. Disagreeing nodes and slow convergence are not covered.
- The fake never answers `MOVED`, `ASK` or `READONLY`.
- Key names are made up per node. `CLUSTER GETKEYSINSLOT` lists as many keys as
  the slot statistics count, but `CLUSTER KEYSLOT` does not map those names
  back to that slot.
- In the `empty` profile the key counts (`DBSIZE`, `INFO keyspace`, slot
  statistics) still say three keys per slot while `SCAN` finds none.
- The fake cluster is one single-threaded process. Its CPU and loop delay are
  reported so that a saturated fake is not mistaken for a slow monitor.
