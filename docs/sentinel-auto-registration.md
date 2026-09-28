---
title: Sentinel Auto-Registration
nav_order: 3.65
---

# Sentinel Node Auto-Registration

A Sentinel connection ("seed") can opt in to automatically registering the
data nodes it monitors — the primary and every replica of each master
group — as its own connections ("children"). Each child is named
`<seed name> · host:port`, and the set is kept in sync with Sentinel's own
view every 30 seconds: nodes that join a group are added, nodes that leave
are retired.

Only the monitored primaries and replicas are registered. Peer Sentinels
(the other instances in the quorum) are never registered as connections —
they exist to coordinate failover, not to be monitored themselves.

## Turning it on

Auto-registration is controlled by the `SENTINEL_AUTO_REGISTER_NODES`
environment variable (boolean, default `false`), and can be overridden per
connection — this is a separate flag from `CLUSTER_AUTO_REGISTER_NODES`;
turning on cluster auto-registration does not affect Sentinel seeds.

The per-connection toggle appears in the same two places as the cluster
one, once a connection is recognized as a Sentinel:

- **Manage Connections** — the list shows the toggle for every Sentinel
  seed. When left unset it reads **"(default)"**, meaning the connection
  follows the `SENTINEL_AUTO_REGISTER_NODES` env var rather than an
  explicit choice.
- **Add Connection** — after a successful connection test reports Sentinel
  mode, the toggle appears in the dialog so you can opt in before saving.

## Data node credentials

Sentinel itself is typically unauthenticated or uses different credentials
than the data nodes it monitors. Because of that, a Sentinel seed's own
username and password are used only to talk to Sentinel — they are not
reused for the discovered primaries and replicas.

The **Add Connection** dialog shows a **Data node credentials** section
(node username / node password) once a test confirms Sentinel mode; these
are the credentials every auto-registered child connects with. They are
only sent when the tested connection is actually a Sentinel — changing the
host afterwards and re-testing against a non-Sentinel target clears them
before the connection is saved.

## Failover behaviour

When Sentinel promotes a replica, the next sync (at most 30 seconds later)
detects the new primary and flips the affected connections' roles in
place — the connection ids, names and history are kept; nothing is deleted
and re-created. A primary change is logged as:

```
Sentinel group <group> primary changed <old host:port> → <new host:port>
```

Failover webhooks are unaffected by this feature: they still fire from the
existing failover-detection path, independent of whether auto-registration
is turned on.

## One Sentinel per quorum

If more than one Sentinel seed monitors the same group, only the first one
to claim a given primary or replica address registers it. The others log
that the address was skipped as already claimed, and do not duplicate or
fight over the connection.

## Reachability

Auto-registered children connect to the address Sentinel itself reports
for each node (`SENTINEL MASTERS` / `SENTINEL REPLICAS`), used as-is. If
Sentinel is behind NAT, Docker, or reports container-internal addresses,
configure `sentinel announce-ip` on the Sentinel instances and
`replica-announce-ip` (and, for the primary, an equivalent announce
setting) on the data nodes so they announce addresses the monitor can
actually reach. Until then, the affected children will register correctly
but show as disconnected.

## Limits

- Sentinel seeds connected over an SSH tunnel are not supported for
  auto-registration, for the same reason as cluster seeds: only the direct
  connection to the seed is tunnelled, so discovered node addresses can't
  be reached through it.
- Credentials are per-seed, not per-group: all data nodes discovered
  through one Sentinel seed share the same node username and password.
  If different master groups behind the same Sentinel use different
  credentials, register them as separate seeds.

## See also

[Cluster Node Auto-Registration](cluster-auto-registration.md) covers the
equivalent feature for Redis/Valkey Cluster, including adoption of
existing connections, retirement/rejoin behaviour, and deletion semantics
— all of which apply the same way to Sentinel-discovered nodes.
