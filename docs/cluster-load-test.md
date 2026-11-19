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
  server is a local stand-in that answers "Pro" (see below). The `.env` file of
  the repository is not read, so the settings a developer keeps there cannot
  change what is measured. Variables exported in the shell still apply.

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
| `--hang 2` | `0` | Nodes that stop answering, from one warm-up before the window. Never the first node |
| `--failover` | off | Promote a replica of shard 1 halfway through the window; needs two shards and a replica. `--hang` then leaves shard 1 alone, so at most nodes - replicas - 2 nodes can hang |
| `--license pro` | `pro` | `pro` or `enterprise` = licensed features on, `community` = no license |
| `--profile realistic` | `realistic` | `realistic` or `empty` replies, see above |
| `--reply-delay-ms 1` | `0` | Hold every reply back this long, to stand in for a network |
| `--call-sites` | off | Also name the function behind every `CLUSTER NODES` read, see "Reading the output" |
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
  registered before the settle time ran out, when a registered connection to a
  node that was not made to hang was down at the end of the window, when the
  license did not come up as asked, when the run did not finish in time, or
  when it crashed. A crash is listed with its signal and error line, so a run
  that ran out of memory reads "killed by SIGABRT" with the heap limit message.

## Reading the output

- **Ticks done / expected** below the expected count does not always mean a
  poller skipped work. A poller starts its next pass one interval after the
  previous one ended, so a pass that takes 150 ms on a 1 s interval gives about
  104 passes in two minutes, not 120.
  Only passes that began and ended inside the window are counted, and
  **Commands per tick** divides the commands of those passes by their number.
  A pass that polled no connection is not counted either. That happens while
  an earlier poll of the connection is still running after the poller stopped
  waiting for it, so with a hung poll the pass count falls below the expected
  count.
- **KB/s received** is dominated by `CLUSTER NODES` on large clusters. Its
  reply grows with the number of nodes, and so does the number of nodes it is
  read from.
- **CLUSTER NODES sent by** names the poller that sent each read. With
  `--call-sites` it also names the function, so the cost of the cluster map can
  be traced to its callers. That reads the call stack for every read, which
  costs CPU in the process being measured. Use it in a run of its own and do
  not read CPU, loop delay or pass times from that run.
- **Hung nodes** stop answering before the window, not inside it: the test
  hangs them, waits one more warm-up and then starts measuring. The figures
  show the cost of nodes that stay silent. The reconnects and events of the
  moment they stop are not in them, and the run takes one warm-up longer.
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

Measured on 2026-11-18 with version 0.55.0 on an 18-core Mac, one run at a
time, with the defaults: 120 second window, 30 second warm-up, one replica per
shard, Pro license, realistic replies, no reply delay. The tables were measured
without `--call-sites`; the split by caller comes from separate runs with it.

The machine was in normal desktop use, with a load average of 4 to 8 when a run
started. Runs of the same size that were repeated differed by up to about 7 %
in pass time.

MB is 10^6 bytes and KB is 10^3 bytes, worked out from the byte counts in the
JSON files. The KB/s columns the test prints divide by 1,024.

A poller starts its next pass one interval after the previous one ended. The
number of passes in the window is therefore about 120 s / (interval + pass
time). Fewer passes mean the cluster is sampled less often, not that work was
skipped.

The tables were measured when a pass that began in the warm-up and ended inside
the window was still counted, so a pass count here can be one higher than the
test would print now. A pass that polled no connection was counted too, which
can add one more pass to the seed run with hung nodes.

### One registered connection

| Nodes | Sockets | Commands/s | Replies MB/s | Anomaly pass p50 / p95 ms | Anomaly passes | Loop delay p99 ms | CPU % | Heap MB | RSS peak MB |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 101 | 365 | 5.0 | 94 / 113 | 110 | 26 | 13 | 133 | 601 |
| 250 | 252 | 529 | 9.6 | 134 / 163 | 106 | 33 | 16 | 138 | 606 |
| 500 | 501 | 709 | 22.5 | 209 / 260 | 99 | 56 | 22 | 143 | 644 |

The fake cluster used 1.5 to 2.6 % CPU and ran at most 2.1 ms late at p99, so
it was not the limit. The command count inside BetterDB matches the count of
the fake cluster within 0.1 % in all three runs.

`CLUSTER NODES` reads per second, by caller, from three runs with
`--call-sites`. Those runs pass a little slower, so their totals are a little
lower than in the runs above, which read the map 71.5, 144.3 and 277.5 times
per second:

| Caller | 100 nodes | 250 nodes | 500 nodes |
|---|---|---|---|
| Replica slot check | 45.4 | 109.4 | 202.1 |
| Fan-out to unregistered primaries | 22.4 | 28.1 | 26.4 |
| Slot migration read | 1.7 | 4.2 | 41.7 (8.3 without the effect below) |
| The connection's own poll | 0.9 | 0.9 | 0.8 |
| Prometheus | 0.2 | 0.2 | 0.2 |
| Total | 70.6 | 142.7 | 271.2 |
| Reply size of one read, KB | 12.6 | 31.6 | 63.5 |
| Replies for the map, MB/s | 0.9 | 4.5 | 17.2 |

- At 500 nodes the cluster map is 17.6 of the 22.5 MB/s of replies in the run
  without `--call-sites`, and the replica slot check sends 75 % of the reads.
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
| 30 | 930 | 1,103 | 628 | 4.0 | 78 / 97 | 112 | 11 | 12 | 756 | 442 | 79 |
| 50 | 2,549 | 2,973 | 1,424 | 10.6 | 171 / 197 | 102 | 34 | 20 | 936 | 1,096 | 2,770 |
| 80 | 6,479 | 7,463 | 2,802 | 28.3 | 455 / 507 | 83 | 171 | 38 | 1,271 | 2,261 | 6,971 |
| 100 (suspect) | 10,099 | 11,601 | 3,476 | 41.4 | 833 / 914 | 66 | 352 | 50 | 1,499 | 2,794 | 10,714 |

- Sockets are nodes x nodes + nodes at every size, give or take one.
- From 50 nodes the limit of 512 pooled node connections is reached all the
  time ("Connection limit reached", "Closing oldest connection"), and it does
  not keep the socket count down: 2,549 open sockets at 50 nodes, about 50 of
  them the registered connections' own. The test counts open sockets, not the
  entries of the pool.
- The replica slot check sends 92 to 98 % of the `CLUSTER NODES` reads, in
  four more runs with `--call-sites`.
- `connection.spike` events in the window: 15, 25, 40 and 50.
- At 100 nodes one anomaly pass takes 0.8 to 0.9 s, so the cluster is sampled
  about every 1.8 s instead of every 1.1 s. 5,622 connections were opened in
  the window.
- The 100-node run is suspect for local ports only: 11,601 of 16,384 were
  held, and it was run with `--force`. All 100 connections were up at the end.
- 250 and 500 nodes with every node registered need 62,500 and 250,000 local
  ports and were not run.

### Failover

One replica promoted halfway through the window:

| Run | `cluster.failover` events | Other |
|---|---|---|
| 100 nodes, one connection | 1 | Pass time unchanged (91 / 109 ms) |
| 30 nodes, every node registered | 30 | Plus one `failover.started` and one `failover.completed` |

One failover gives one event per registered connection.

### Hung nodes

Two nodes accept TCP and stop replying (`--hang 2`). "Before" is the state the
other tables were measured in, on 2026-11-18. "After" has the timeouts for
silent nodes described below and was measured on 2026-11-19 on the same
machine, in desktop use with a load average of about 3.4. Each figure is one
run, not repeated.

| Run | Figure | Before | After | No hung nodes |
|---|---|---|---|---|
| 100 nodes, one connection | Anomaly pass p50 / p95 ms | 4,023 / 9,038 | 95 / 111 | 94 / 113 |
| | Anomaly passes | 24 | 109 | 110 |
| | Prometheus pass p50 / p95 ms | 37 / 4,012 | 39 / 46 | |
| | Commands/s | 94 | 354 | 365 |
| 30 nodes, every node registered | Anomaly pass p50 / p95 ms | 5,003 / 5,207 | 71 / 91 | 78 / 97 |
| | Anomaly passes | 19 | 112 | 112 |
| | Prometheus pass p50 / p95 ms | 5,002 / 5,003 | 45 / 51 | |
| | Commands/s | 116 | 548 | 628 |
| | Hung connections listed as connected | 2 of 2 | 0 of 2 | |
| | Error lines in the log | 38 | 0 | 0 |

What changed between the two columns:

- A command sent to a single node gives up after 5 seconds
  (`CLUSTER_NODE_COMMAND_TIMEOUT_MS`). A node that let a command or a connect
  time out is skipped for 30 seconds and tried again in the background.
- The health ping has a deadline of 5 seconds. Two pings in a row without an
  answer report the connection as down.
- A poller pass waits for a slow connection once. After that the connection is
  still polled every pass, but the pass does not wait for it until one of its
  polls ends in time.

How to read it:

- Before, two silent nodes stretched one anomaly pass to 4 to 9 s, so the whole
  cluster was sampled every 5 to 6 s instead of about every 1.1 s. With every
  node registered the two hung connections were still listed as connected at
  the end of the window, and the log had 38 "Failed to poll metrics" errors
  and 51 "still running, skipping" warnings.
- After, pass times and pass counts are close to those of the run without
  hung nodes.
  The two hung connections are listed as disconnected, and the log has none of
  those errors or warnings.
- With every node registered a pass no longer waits for the two hung
  connections, so its time is that of the 28 healthy ones. That is also why
  fewer commands are sent than without hung nodes.
- No `instance.down` is in either window's event count. The nodes stop
  answering 30 seconds before the window starts. After the change the event
  is due 20 to 30 seconds after that, which is still before the window.
- The "Before" pass counts can be one higher, as said at the top of the
  results. The "After" runs do not count a pass that polled no connection.

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
