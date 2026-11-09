---
title: Cluster Auto-Registration
nav_order: 3.6
---

# Cluster Node Auto-Registration

A cluster connection ("seed") can opt in to automatically registering every
node that `CLUSTER NODES` reports — primaries and replicas alike — as its own
connection ("child"). Each child is named `<seed name> · host:port`, and the
set is kept in sync with the live cluster every 30 seconds: nodes that join
are added, nodes that leave are retired.

Each seed's sync has a 30 second budget and connects up to four new nodes at a
time, so one seed with many unreachable nodes neither delays other seeds nor
holds its own lock for long. Nodes not reached within the budget are picked up
on the next sync. This applies to Sentinel seeds as well.

## Turning it on

Auto-registration is controlled by the `CLUSTER_AUTO_REGISTER_NODES`
environment variable (boolean, default `false`), and can be overridden per
connection.

The per-connection toggle appears in two places once a connection is
recognized as a cluster:

- **Manage Connections** — the list shows the toggle for every cluster seed.
  When left unset it reads **"(default)"**, meaning the connection follows
  the `CLUSTER_AUTO_REGISTER_NODES` env var rather than an explicit choice.
- **Add Connection** — after a successful connection test reports cluster
  mode, the toggle appears in the dialog so you can opt in before saving.

## Credentials and addressing

Child connections reuse the seed's username, password and TLS settings —
there is nothing to configure per node. They connect to the address the
cluster itself announces in `CLUSTER NODES`, used as-is.

If the cluster is behind NAT or Docker port mapping and the announced
addresses aren't reachable from the monitor, the affected children will show
as disconnected. Configure `cluster-announce-ip` and `cluster-announce-port`
on the cluster nodes so they announce addresses the monitor can actually
reach.

### Seeds that resolve to several nodes

A seed host can be a DNS name that resolves to several cluster nodes, such as
the headless Service a Kubernetes operator creates for a cluster. The seed then
connects to whichever node the name resolves to, and to a different one after a
reconnect. The seed is an alias when those addresses match more than one node
in `CLUSTER NODES`, and every node is then registered as a child, including the
node that answered the sync, so the children stay stable across syncs. Several
addresses for one dual-stack node are not an alias: when only the node that
answered matches, the seed stays that one node. A seed changes between an alias
and a single node only when two syncs in a row agree, so one stale answer
cannot register a single node twice, and a rollout that leaves one pod behind
the name for a sync does not retire the node that answered.

When no node announces the seed's address, as with a ClusterIP Service, a load
balancer VIP, NAT or a port mapping, the address alone cannot tell, so the
monitor watches which node answers each sync. A VIP lands on an arbitrary node,
so a node that answered before soon answers again after another one did, or
three different nodes answer; the seed then fronts several nodes and every node
is registered. One node behind NAT keeps answering as itself, and after a
failover or replacement as the new node: once that node has answered three
syncs in a row, it is the seed's node, and the nodes before it no longer count,
so a later failback is treated as another move. Membership is left as it is
while that is still unclear, which lasts at most a few syncs. A failback or
two quick replacements can look like several nodes before the new one has
answered three syncs in a row. Once it has, the seed is that one node again,
so it is not registered as its own child.

Slow log and command log entries collected through such a seed are stored
against the node that served them, not the seed's hostname, so history stays
complete and attributable when the seed moves between nodes.

The node is identified by its `run_id` from `INFO server`, which stays the
same whatever address reaches it. When `INFO` is refused (an ACL or a blocked
command), entries are stored against the serving address instead, also for a
connection that reported a `run_id` before. Behind a shared proxy or VIP that
address is the same for every node, so their log IDs can overlap and a move of
the seed can skip entries that belong to the node now answering. Allow `INFO`
so each node is attributed by its `run_id`. A poll in which `INFO` fails for
any other reason, such as a timeout, is skipped. The next poll does not always
get those entries back: each poll fetches at most 128 entries per log type, and
it may reach a different node. They are stored only if a later poll reaches the
same node while the entries are still among the 128 most recent in its log.
If a connection's entries were stored under the address and `INFO` later starts
working, the entries still in a server's log (at most 128 per log type) are
stored once more under that server's `run_id`, so history can show those
entries twice. This happens once for each server whose entries were stored
under the address, so a seed that moved between nodes while `INFO` was refused
can repeat it for several of them.

### TLS certificates

`CLUSTER NODES` always reports nodes by IP address. When a node also
announces a hostname (`cluster-announce-hostname`), its child connection
still dials the IP but accepts a certificate issued for either that hostname
or the IP, so certificates issued for hostnames only work without extra
configuration. If a node starts announcing a hostname later, or changes it,
the child picks it up on the next sync and reconnects.

This applies to auto-registered children only. An adopted connection keeps
verifying against the host it was created with.

A node that announces no hostname is verified against its IP, which only
succeeds when the certificate lists that IP as a subject alternative name.
Clusters whose certificates cover hostnames only and whose nodes announce no
hostname are not supported: the children register but stay disconnected, and
the monitor log names the setting to change. Set `cluster-announce-hostname`
on each node to fix it.

Seeds connected over an SSH tunnel are not supported for auto-registration;
only the direct connection to the seed is tunnelled, so discovered peer
addresses can't be reached through it.

## Existing connections

If a connection already exists at a discovered node's address, it is
adopted rather than duplicated: it keeps its existing name and credentials,
gains an **ADOPTED** badge, and is never deleted by this feature — only
detached if the seed itself is later removed.

A connection is only left alone when it is a seed in its own right: its
auto-register toggle is explicitly on, or it already has child connections.
A connection that merely inherits `CLUSTER_AUTO_REGISTER_NODES=true` is
adopted by the first seed that discovers it.

## Nodes leaving and rejoining

When a node drops out of the cluster, its child connection is retired: it
stops being polled, is shown greyed out with a "left cluster" label, and is
never deleted outright. If the same address rejoins the cluster later, the
connection is reactivated with its history intact.

To avoid mass false retirements from a flaky read, if more than half of a
seed's active auto-registered nodes would be retired at once, retirement is
held for one extra sync and only applied if the same set is still missing.

Retired nodes are permanently removed once they fall outside the
configured data-retention window. If no retention window is set, retired
nodes are kept forever until deleted by hand.

## Deleting

Deleting a seed connection deletes all of its auto-registered nodes and
detaches any adopted connections, leaving them as standalone connections.
Deleting an individual auto-registered node removes it, but it comes back
on the next sync unless the seed's auto-register toggle is turned off.

## What stays on the seed

Cluster, Key Analytics and Migration continue to operate against the seed
connection only — they are not duplicated per node. Child connections show
a "View cluster → &lt;seed&gt;" link back to the seed instead.

Key Analytics on the seed covers the whole cluster: each collection scans
the seed node and every connected child that is currently a primary, and
stores one merged result under the seed. Replicas are not scanned, and no
child is scanned on its own. The sample size applies per primary. Without
auto-registration a cluster connection still scans only the node it is
connected to.

## See also

[Sentinel Node Auto-Registration](sentinel-auto-registration.md) covers
the equivalent feature for Sentinel-monitored primaries and replicas.
