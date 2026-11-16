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
