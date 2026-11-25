# betterdb-openeverest

The BetterDB plugin for [OpenEverest](https://openeverest.io). It adds a **BetterDB** tab to
Valkey instances and streams each enabled instance to BetterDB Cloud or a self-hosted BetterDB:
metrics, slow commands and COMMANDLOG, clients, ACL log, cluster topology and keyspace analytics.

The chart installs:

- a `Plugin` CR (`extensions.openeverest.io/v1alpha1`) with a `clusterDetailTab` scoped to
  `providers: [valkey]` and a `settingsPanel` for the BetterDB URL and agent token;
- one Deployment of `betterdb/agent` in `openeverest` mode: the plugin backend behind
  OpenEverest's plugin proxy, plus one agent connection per Valkey node of every enabled instance;
- a Service, a ServiceAccount, a ClusterRole/Role set that reads Instances and connection Secrets
  (never writes a database CR), and optionally a settings Secret.

Needs BetterDB Cloud or a self-hosted Monitor 0.57.0 or later. Full guide:
[docs.betterdb.com/install/openeverest](https://docs.betterdb.com/install/openeverest).

## Install

```bash
helm install betterdb-openeverest oci://ghcr.io/betterdb/charts/betterdb-openeverest \
  --namespace everest-system \
  --set betterdb.url=wss://<workspace>.app.betterdb.com/agent/ws \
  --set betterdb.token=<agent token>
```

Then open a Valkey instance, pick the BetterDB tab and press **Enable**.

The URL and token come from Helm values or `betterdb.existingSecret`, and only from there: the
settings panel in OpenEverest shows them read-only. The backend is a ClusterIP Service any pod
can reach, so it offers no way to repoint the agents; `networkPolicy.enabled` additionally keeps
anything but everest-server from reaching it. Changes to the Secret are picked up without a
restart.

## How credentials work

Enabling calls OpenEverest's `GET …/instances/{name}/connection` with the user's own session
token; OpenEverest answers 200 only to users with the `read-connection` permission on that
instance, so a 403 refuses the request. The plugin's ServiceAccount then reads the instance's
connection Secret (`<instance>-conn`) and re-reads it when it changes, so password rotation
reconnects on its own. provider-valkey publishes the `default` admin user, so the agent runs
**read-only**: BetterDB refuses `CLIENT KILL`, `CONFIG SET`, `SLOWLOG`/`COMMANDLOG`/`LATENCY RESET`
and every write on these connections. No pod is restarted and no database CR is modified.

## Values

| Value | Default | Description |
|---|---|---|
| `betterdb.url` | `""` | Agent URL: `wss://<workspace>.app.betterdb.com/agent/ws` (Cloud) or `wss://<host>/api/agent/ws` (self-hosted). |
| `betterdb.token` | `""` | Agent token from BetterDB (Connections → Via Agent). |
| `betterdb.existingSecret` | `""` | Existing Secret with keys `url` and `token`, instead of the two values above. |
| `betterdb.ca` | `""` | PEM bundle to trust, on top of the public roots, for a self-hosted Monitor behind a private CA (own Secret, mounted, `BETTERDB_CA_FILE`). |
| `betterdb.existingCaSecret.name` / `.key` | `""` / `ca.crt` | Existing Secret holding that bundle instead of `betterdb.ca`. |
| `betterdb.caFile` | `""` | Path to a CA bundle already mounted via `extraVolumes`; ignored when `betterdb.ca` is set. |
| `watchNamespaces` | `[]` | Namespaces whose Instances and Secrets the plugin may read. Empty: cluster-wide. |
| `openeverest.apiUrl` | `""` | OpenEverest API for the authorization check; empty uses the in-cluster default. |
| `openeverest.clusterName` | `main` | OpenEverest's name for this Kubernetes cluster. |
| `plugin.name` | `betterdb` | Plugin CR name; cluster-scoped, one install per OpenEverest. |
| `plugin.compatibleHostVersions` | `""` | Semver range of host versions to accept; empty skips the check. |
| `networkPolicy.enabled` | `true` | Admit only everest-server pods (`networkPolicy.serverPodSelector`, in `networkPolicy.openeverestNamespace` or the release namespace) to the backend. Needs an enforcing CNI. |
| `image.tag` | `""` | Empty resolves to the chart's `appVersion`. |
| `replicaCount` | `1` | Keep at 1: a second pod would open duplicate connections. |

`helm.sh/resource-policy` is not set on the settings Secret or the targets ConfigMap: values set
inline are re-applied on every upgrade, and the ConfigMap the backend creates is not managed by the
chart at all (it survives `helm upgrade` and is removed by `helm uninstall` only by hand).

## Checks

```bash
helm lint charts/betterdb-openeverest
helm unittest charts/betterdb-openeverest
helm template t charts/betterdb-openeverest -n everest-system -f charts/betterdb-openeverest/ci/namespaces-values.yaml
```
