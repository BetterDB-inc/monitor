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
