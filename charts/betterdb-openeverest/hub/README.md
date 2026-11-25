# BetterDB

Monitoring for **Valkey** instances in [BetterDB](https://betterdb.com) Cloud or a self-hosted
BetterDB Monitor: metrics history, slow commands and COMMANDLOG, clients, ACL log, cluster
topology and keyspace analytics, with anomaly detection and alerting on top.

The plugin adds a **BetterDB** tab to every Valkey instance (`provider-valkey`). Enabling it
there starts an in-cluster agent that connects to every node of the instance and streams to the
BetterDB configured on the Helm release (`betterdb.url` and `betterdb.token`, or
`betterdb.existingSecret`). Nothing is exposed inbound: the agent dials out over `wss`.

## What you need

- OpenEverest 2.0.0-alpha.1 or later with `provider-valkey`.
- A BetterDB Cloud workspace, or a self-hosted BetterDB Monitor **0.57.0 or later** (Docker, or
  the `betterdb-monitor` Helm chart) reachable from the cluster over `wss://`.
- An agent token from BetterDB (Connections → Via Agent).

## Permissions

- **To enable monitoring on an instance** a user needs the `read-connection` permission on it.
  The plugin checks this by calling OpenEverest's `/connection` endpoint with the user's own
  session token; a 403 refuses the request.
- **The plugin's ServiceAccount** reads `instances.core.openeverest.io` and the connection
  Secrets they point at (`get`, `list`, `watch`), cluster-wide by default or limited by the
  `watchNamespaces` value. It writes only its own ConfigMap and Secret in its namespace, and
  never modifies a database CR.

## Credentials and read-only mode

provider-valkey publishes the `default` admin user in the connection Secret, and that is what
the agent uses today. The connections are therefore **read-only**: BetterDB refuses
`CLIENT KILL`, `CONFIG SET`, `SLOWLOG RESET`, `COMMANDLOG RESET`, `LATENCY RESET` and every
write command on them, on the server side. The agent re-reads the Secret when it changes, so
password rotation needs no action. **No pods are restarted** and no instance spec is modified.

## Install

The hub installs the chart into `everest-system`. Set the BetterDB URL and agent token as Helm
values (the Settings → BetterDB panel in OpenEverest shows them but cannot change them):

```bash
helm install betterdb-openeverest oci://ghcr.io/betterdb/charts/betterdb-openeverest \
  --namespace everest-system \
  --set betterdb.url=wss://<workspace>.app.betterdb.com/agent/ws \
  --set betterdb.token=<agent token>
```

Or afterwards, on the installed release:

```bash
helm upgrade betterdb-openeverest oci://ghcr.io/betterdb/charts/betterdb-openeverest \
  --namespace everest-system --reuse-values \
  --set betterdb.url=wss://<workspace>.app.betterdb.com/agent/ws \
  --set betterdb.token=<agent token>
```

or point `betterdb.existingSecret` at a Secret with keys `url` and `token`.

Full guide, including self-hosted BetterDB and private CAs:
[docs.betterdb.com/install/openeverest](https://docs.betterdb.com/install/openeverest).
