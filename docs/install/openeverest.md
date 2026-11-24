---
title: OpenEverest (plugin)
parent: Install
nav_order: 5
permalink: /install/openeverest/
---

# BetterDB plugin for OpenEverest

[OpenEverest](https://openeverest.io) runs databases on Kubernetes through providers. The
BetterDB plugin adds a **BetterDB** tab to every Valkey instance (`provider-valkey`); enabling it
there starts an in-cluster agent that connects to each node of the instance and streams to
BetterDB Cloud or a self-hosted BetterDB Monitor. Nothing is exposed inbound and no pod is
restarted.

The plugin ships as one Helm chart, `betterdb-openeverest`, installed next to OpenEverest.

## What you need

- OpenEverest `2.0.0-alpha.1` or later, with `provider-valkey` installed.
- Somewhere to stream to:
  - **BetterDB Cloud**: a workspace. The agent URL is `wss://<workspace>.app.betterdb.com/agent/ws`.
  - **Self-hosted**: a BetterDB Monitor the cluster can reach over `wss://`
    ([Docker](docker.md) or the [`betterdb-monitor` chart](kubernetes.md)). The agent URL is
    `wss://<monitor-host>/api/agent/ws`; for a Monitor in the same cluster the Service works
    too, e.g. `ws://betterdb-monitor.betterdb.svc:3001/api/agent/ws`.
- An **agent token**, created in BetterDB under Connections → Via Agent.

## Install

```bash
helm install betterdb-openeverest oci://ghcr.io/betterdb/charts/betterdb-openeverest \
  --namespace everest-system \
  --set betterdb.url=wss://<workspace>.app.betterdb.com/agent/ws \
  --set betterdb.token=<agent token>
```

The URL and token come from Helm values, or from `betterdb.existingSecret` (a Secret with keys
`url` and `token`) for anything that rotates. OpenEverest's **Settings → BetterDB** panel shows
them read-only by default. Editing there is opt-in:

```bash
--set plugin.allowSettingsEdit=true
```

It is off by default because the backend is a plain ClusterIP Service: without the flag, no
request can repoint where the agents stream to, whatever headers it carries. With the flag on, the
backend accepts a change only after OpenEverest confirms the caller's session
(`GET /v1/clusters/{cluster}/plugin-context` with the forwarded token), and the chart's
NetworkPolicy (`networkPolicy.enabled`, on by default) admits only everest-server pods to the
backend. The policy needs a CNI that enforces NetworkPolicy; kind's default CNI does not.

Then reload the OpenEverest UI, open a Valkey instance and pick the **BetterDB** tab:

| State | Meaning |
|---|---|
| Off | Not enabled for this instance. |
| Connecting | Enabled; waiting for connection details, or dialling the nodes. |
| Monitoring | Every node streams to BetterDB. The tab lists the nodes with their connection state. |
| Error | Something is wrong: BetterDB not configured, the Secret unreadable, nodes unreachable. The message says which. |

**Open in BetterDB** links to the BetterDB the plugin streams to. Each node appears there as its
own connection, named `<namespace>/<instance>/<pod>`.

### Self-hosted BetterDB behind a private CA

If your Monitor's certificate is signed by a private CA, give the agent the CA bundle:

```bash
helm install betterdb-openeverest oci://ghcr.io/betterdb/charts/betterdb-openeverest \
  --namespace everest-system \
  --set betterdb.url=wss://monitor.internal.example/api/agent/ws \
  --set betterdb.token=<agent token> \
  --set-file betterdb.ca=./internal-ca.pem
```

The bundle is mounted into the pod and passed as `BETTERDB_CA_FILE`; the system trust store still
applies. `betterdb.caFile` points at a bundle you mount yourself through `extraVolumes`.

The Monitor's ingress must pass WebSocket upgrades on `/api/agent/ws`; see the
[Kubernetes guide](kubernetes.md).

### Limiting what the plugin can read

By default the plugin's ServiceAccount may read Instances and Secrets cluster-wide (the same model
as OpenEverest's user-management plugin). To narrow it:

```bash
--set 'watchNamespaces={databases,staging}'
```

This replaces the cluster-wide ClusterRole with a Role in each listed namespace; instances
elsewhere cannot be enabled.

## Permissions

Two kinds of permission are involved.

**The user who presses Enable** needs OpenEverest's `read-connection` permission on the instance.
The plugin checks it by calling `GET /v1/clusters/{cluster}/namespaces/{ns}/instances/{name}/connection`
with the user's own session token, exactly as OpenEverest's other credential-using plugins do.
A 403 refuses the request; the token is used for that one call and never stored. Disabling uses
the same check. OpenEverest itself requires a valid session and the `use` permission on the
plugin for every POST/PUT reaching the backend.

**The plugin's ServiceAccount** gets, from the chart:

| Scope | Resource | Verbs | Why |
|---|---|---|---|
| cluster-wide or `watchNamespaces` | `instances.core.openeverest.io` | get, list, watch | Follow `status.connectionSecretRef`; drop instances that are deleted. |
| cluster-wide or `watchNamespaces` | `secrets` | get, list, watch | Read each enabled instance's connection Secret and re-read it on rotation. |
| cluster-wide | `namespaces` (`kube-system` only) | get | Take the namespace UID as a stable cluster id. |
| plugin namespace | its targets ConfigMap, its settings Secret | get, list, watch, update, patch (+ create) | Remember which instances are enabled; store the BetterDB URL and token. |

It has **no write access to any database CR**. Instances are never modified and no pod is
restarted.

## Credentials and read-only mode

provider-valkey publishes the `default` admin user in the instance's connection Secret
(`<instance>-conn`: host, port, username, password, and with TLS on `ssl=true`, `ca.crt`, and
`tls.crt`/`tls.key` when client certificates are accepted). That is what the agent uses today;
provider-valkey has no monitor user yet.

Because of that, these connections run **read-only**. The agent asks for it in its hello and the
BetterDB server enforces it: `CLIENT KILL`, `CONFIG SET`, `SLOWLOG RESET`, `COMMANDLOG RESET`,
`LATENCY RESET`, `ACL LOG RESET` and every write are refused before they reach the agent, in the
UI and in the CLI. Everything BetterDB reads (INFO, slow and command logs, clients, ACL log,
cluster topology, memory, keyspace sampling) works as usual.

The agent connects to each node by pod IP with TLS verified against the Secret's CA, chain only,
since pod IPs are not in the server certificate's names. It re-reads the Secret when it changes,
so a password rotation reconnects on its own.

## How the agent finds the nodes

provider-valkey always runs Valkey in cluster mode. The agent asks the instance's Service for
`CLUSTER SHARDS` (or `CLUSTER NODES`), opens one connection per node and follows no redirects, so
each node is monitored as itself. Discovery runs again every minute to follow scaling and
failover. In BetterDB every node keeps a stable identity (cluster, namespace, instance, node id),
so history survives agent restarts, fail-overs and token rotation.

## Troubleshooting

```bash
kubectl logs -n everest-system deploy/betterdb-openeverest -f
```

- *"enabling BetterDB needs the read-connection permission"*: ask an OpenEverest admin for
  `read-connection` on the instance (or namespace).
- *"BetterDB is not configured"*: set the URL and token under Settings → BetterDB.
- *"instance ... is not visible to the plugin"*: the instance is outside `watchNamespaces`, or in
  another OpenEverest cluster than the one the plugin runs in (`openeverest.clusterName`).
- *Connecting* for long: the instance has not published `status.connectionSecretRef` yet, or the
  pods are not reachable from the plugin namespace (network policies).
- *WS closed: 4003*: another agent streams the same node with the same token; keep
  `replicaCount: 1`.

## Not yet

- The Monitor shows each node as a separate connection; grouping by OpenEverest instance is
  planned.
- A "Connect OpenEverest" screen in BetterDB that issues the token and prints the `helm install`
  command is planned; today you create the token under Connections → Via Agent.
- A monitoring `integration` listing (OpenEverest's native Monitoring step) follows once
  provider-valkey publishes connection sources and a monitor credential.
