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
  and so on) with replies of a realistic size for the cluster. It counts every
  command and every byte, per node. It can also make a node hang (the socket
  stays open, nothing is answered) and promote a replica.
- **The API.** The real application with in-memory storage, pointed at the
  first node. Nothing is mocked: every poller runs on its normal interval.

## What it measures

Over a fixed window, after a warm-up:

| Figure | Meaning |
|---|---|
| Commands/s | Commands the whole cluster received from BetterDB |
| KB/s received | Reply bytes BetterDB had to read and parse |
| Busiest node cmd/s | Load on the single node that got the most commands |
| Sockets | Open connections from BetterDB to the cluster |
| Poll time | How long one pass of a poller takes, p50 and p95 |
| Ticks done / expected | Whether a poller keeps up with its own interval |
| Commands per tick | Commands one pass of a poller sends |
| CPU, heap, RSS | Cost inside the BetterDB process |
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
| `--nodes 100,250,500` | `100,250,500` | Cluster sizes |
| `--modes seed,auto` | both | `seed` = one connection, `auto` = every node registered |
| `--replicas 1` | `1` | Replicas per shard |
| `--warmup 30` | `30` | Seconds before measuring starts |
| `--measure 120` | `120` | Seconds measured |
| `--settle 300` | `300` | Longest wait for auto-registration to finish, seconds |
| `--hang 2` | `0` | Nodes that stop answering when the window starts |
| `--failover` | off | Promote a replica of shard 1 halfway through the window |
| `--out <dir>` | none | Also write one JSON file per run and `report.md` |
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

## Reading the output

- **Ticks done / expected** below the expected count does not always mean a
  poller skipped work. A poller starts its next pass one interval after the
  previous one ended, so a pass that takes 150 ms on a 1 s interval gives about
  104 passes in two minutes, not 120.
- **KB/s received** is dominated by `CLUSTER NODES` on large clusters. Its
  reply grows with the number of nodes, and so does the number of nodes it is
  read from.
- **Events** lists what would have been sent to webhooks. `cluster.failover`
  is counted before the license check, so it shows up without a license.
- Run it on a quiet machine. The API and the fake cluster each use one CPU
  core; other load on the machine changes the poll times.
