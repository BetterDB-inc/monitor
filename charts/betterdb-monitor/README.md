# betterdb-monitor Helm chart

Deploys [BetterDB Monitor](https://github.com/BetterDB-inc/monitor) — monitoring,
analytics, and anomaly detection for Valkey and Redis — on Kubernetes.

## Install

```bash
helm repo add betterdb https://docs.betterdb.com/charts
helm repo update
helm install betterdb-monitor betterdb/betterdb-monitor \
  --namespace betterdb --create-namespace \
  --set db.host=my-valkey.default.svc.cluster.local \
  --set db.password=yourpassword
```

Then open the dashboard (the release notes print the exact command):

```bash
kubectl port-forward -n betterdb svc/betterdb-monitor 3001:3001
```

Or install straight from a checkout of this repo:

```bash
helm install betterdb-monitor charts/betterdb-monitor -n betterdb --create-namespace
```

## Values

The full annotated reference is [values.yaml](values.yaml). The ones that matter:

| Key | Default | Description |
|-----|---------|-------------|
| `db.host` | `""` | Valkey/Redis to monitor. Empty = configure in the UI later. |
| `db.port` / `db.username` / `db.type` | `6379` / `default` / `auto` | Connection details. |
| `db.password` | `""` | Rendered into a chart-managed Secret. |
| `db.existingSecret` / `db.existingSecretKey` | `""` / `db-password` | Bring-your-own Secret instead. |
| `storage.type` | `memory` | `memory` (history lost on restart) or `postgres` (durable). |
| `storage.url` | `""` | `postgresql://user:pass@host:5432/db` when `storage.type=postgres`. |
| `storage.existingSecret` | `""` | Bring-your-own Secret holding the URL (key `storage-url`). |
| `image.tag` | `""` | Empty = `<appVersion>-no-ai` (standard image). Set `X.Y.Z` for the AI variant. |
| `service.type` | `ClusterIP` | `ClusterIP`, `NodePort` or `LoadBalancer`. |
| `service.port` | `3001` | Service port. |
| `service.nodePort` | `null` | Fixed node port (30000-32767) for `NodePort`/`LoadBalancer`. Empty = allocated by Kubernetes. Ignored for `ClusterIP`. |
| `service.annotations` | `{}` | Service annotations, e.g. cloud load-balancer settings or ExternalDNS. Values must be strings (use `--set-string`). |
| `service.labels` | `{}` | Extra Service labels, added to the chart's own. |
| `service.loadBalancerClass` | `""` | `LoadBalancer` only. Load-balancer implementation, e.g. `service.k8s.aws/nlb`. Empty = cluster default. |
| `service.loadBalancerSourceRanges` | `[]` | `LoadBalancer` only. Client CIDRs allowed through, e.g. `["203.0.113.0/24"]`. Empty = no restriction. |
| `service.externalTrafficPolicy` | `""` | `NodePort`/`LoadBalancer` only. `Cluster` or `Local` (keeps the client source IP). Empty = Kubernetes default (`Cluster`). |
| `ingress.enabled` | `false` | Standard Ingress block (`className`, `hosts`, `tls`). |
| `persistence.enabled` | `false` | PVC at `/app/data` for license state (see below). |
| `license.key` | `""` | Online Pro/Enterprise license key. |
| `license.offline.existingSecret` | `""` | Secret with an offline `.jwt` token for air-gapped installs. |
| `license.offline.existingSecretKey` | `license.jwt` | Key within that Secret; also the mounted filename. Must match the Secret's key. |
| `resources` | requests `100m`/`256Mi`, limits `1`/`1Gi` | Pod CPU/memory. The 1Gi limit is a hard cap — raise it for busy instances. |
| `telemetry` | `true` | Set `false` to disable anonymous telemetry. |
| `webhooks.allowedPrivateCidrs` | `[]` | Private CIDRs webhooks may deliver to, e.g. `["10.244.0.0/16"]`. Empty = public receivers only. See [docs/webhooks.md](../../docs/webhooks.md#receivers-on-a-private-network). |
| `webhooks.allowedPrivateHosts` | `[]` | Hostnames (exact or `*.suffix`) that may resolve to a private address, e.g. `["*.svc.cluster.local"]`. |
| `extraEnv` / `extraEnvFrom` | `[]` | Any other env from [docs/configuration.md](../../docs/configuration.md). |
| `metrics.token` / `metrics.existingSecret` | `""` | Bearer token required to scrape `/api/prometheus/metrics`; also used by the ServiceMonitor. |
| `metrics.serviceMonitor.enabled` | `false` | Create a Prometheus Operator `ServiceMonitor`. |
| `metrics.prometheusRule.enabled` | `false` | Install the alert pack as a `PrometheusRule`. |
| `metrics.grafanaDashboards.enabled` | `false` | Publish the Grafana dashboard pack as sidecar ConfigMaps. |

## Prometheus Operator / kube-prometheus-stack

One release wires the monitor into an existing kube-prometheus-stack: a
ServiceMonitor for scraping, the alert pack as a PrometheusRule, and the
Grafana dashboards as ConfigMaps the Grafana sidecar loads.

```bash
kubectl create secret generic betterdb-scrape -n betterdb \
  --from-literal=metrics-token="$(openssl rand -hex 32)"

helm upgrade --install betterdb-monitor betterdb/betterdb-monitor -n betterdb \
  --set db.host=my-valkey.default.svc.cluster.local \
  --set metrics.existingSecret=betterdb-scrape \
  --set metrics.serviceMonitor.enabled=true \
  --set metrics.serviceMonitor.labels.release=kube-prometheus-stack \
  --set metrics.prometheusRule.enabled=true \
  --set metrics.prometheusRule.labels.release=kube-prometheus-stack \
  --set metrics.grafanaDashboards.enabled=true \
  --set metrics.grafanaDashboards.namespace=monitoring
```

- The `release` label must match your Prometheus's `serviceMonitorSelector` /
  `ruleSelector` (kube-prometheus-stack selects on its own release name).
- The token Secret is read by both the pod (`PROMETHEUS_METRICS_TOKEN`) and the
  ServiceMonitor, so it lives in the release namespace with them.
- Dashboards go to the namespace the Grafana sidecar watches. They are labelled
  `grafana_dashboard: "1"` and annotated `grafana_folder: BetterDB`; folder
  placement needs the sidecar's `folderAnnotation` set to `grafana_folder`.
- The ServiceMonitor and PrometheusRule need the `monitoring.coreos.com` CRDs.
- Every alert names the monitored instance in its `connection` label. The rules
  are [docs/alertmanager-rules.yml](../../docs/alertmanager-rules.yml); add your
  own groups with `metrics.prometheusRule.additionalGroups`.

The dashboards and rules in this chart are byte-identical copies of
`deploy/observability/dashboards/` and `docs/alertmanager-rules.yml` (Helm can
only package files inside the chart). Edit the originals, then run
`node scripts/sync-chart-observability.mjs`; CI fails if the copies drift.

The `service.*` options are rendered only for the Service types Kubernetes
accepts them on, so a value set for one type is ignored, not an error, after a
switch to another. Unknown `service.*` keys are rejected by the values schema
(a typo such as `--set service.nodeport=30301` fails the install or upgrade)
instead of being silently ignored.

```bash
# Fixed NodePort, e.g. behind a kind host-port mapping
helm install betterdb-monitor betterdb/betterdb-monitor -n betterdb \
  --set service.type=NodePort --set service.nodePort=30301

# Internal AWS NLB, reachable only from one range, keeping the client IP
helm install betterdb-monitor betterdb/betterdb-monitor -n betterdb \
  --set service.type=LoadBalancer \
  --set service.loadBalancerClass=service.k8s.aws/nlb \
  --set-string 'service.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-scheme=internal' \
  --set 'service.loadBalancerSourceRanges={10.0.0.0/8}' \
  --set service.externalTrafficPolicy=Local
```

## Persistence

Two different kinds of state, two different knobs:

- **Monitoring history** (slowlogs, metrics, events) lives in the storage
  backend. The default `storage.type=memory` keeps it in the pod — fine for
  trying things out, gone on restart. Point `storage.type=postgres` +
  `storage.url` at a PostgreSQL instance for durable history.
- **License state** (offline tokens, the online outage-grace token) lives on
  disk under `/app/data`. `persistence.enabled=true` gives it a PVC so paid
  tiers survive pod rescheduling. The pod runs as UID 1001 and the chart sets
  `fsGroup: 1001`, so the volume is writable out of the box.

## Air-gapped licensing

```bash
kubectl create secret generic betterdb-license -n betterdb \
  --from-file=license.jwt=/path/to/betterdb-license.jwt

helm upgrade betterdb-monitor betterdb/betterdb-monitor -n betterdb --reuse-values \
  --set license.offline.existingSecret=betterdb-license \
  --set persistence.enabled=true
```

With an offline token and no online key, the monitor makes zero outbound
requests. See [docs/offline-licenses.md](../../docs/offline-licenses.md).

## Upgrade

```bash
helm repo update
helm upgrade betterdb-monitor betterdb/betterdb-monitor -n betterdb --reset-then-reuse-values
```

`--reset-then-reuse-values` (Helm 3.14+) keeps your overrides and picks up the
new chart's defaults; `--reuse-values` would keep the old defaults too. On
older Helm, export the overrides already stored on the release and pass that
file. A values file written by hand can omit a connection or storage setting
that was applied only with `--set`, and the upgrade then drops it:

```bash
# The overrides can hold credentials: mktemp creates a file only you can read.
values="$(mktemp)"
helm get values betterdb-monitor -n betterdb -o yaml > "$values" &&
  helm upgrade betterdb-monitor betterdb/betterdb-monitor -n betterdb -f "$values"
rm -f "$values"
```

Either way, an override stored on the release wins over the new default. A
release installed from a full copy of the chart's `values.yaml` stores the old
`startupProbe.failureThreshold` (30, 150 seconds), which a long first start
after an update can exceed, restarting the pod again and again. Check with
`helm get values betterdb-monitor -n betterdb`, and if it is set, add
`--set startupProbe.failureThreshold=120` to the upgrade.

## Releasing the chart (maintainers)

The chart is released **in lockstep with the app**: chart `version` ==
`appVersion` == the app version, so `helm search repo betterdb --versions`
shows which monitor release each chart deploys. There are no chart-only
releases; a chart change merged between releases ships with the next app
release (or an app patch release).

1. In the release commit, bump every version field with one command:

   ```bash
   node scripts/bump-version.mjs 0.57.0
   ```

   It updates `package.json`, `apps/api/package.json`, `apps/web/package.json`
   and, in `Chart.yaml`, `version`, `appVersion` and both
   `artifacthub.io/images` tags (`<v>-no-ai` and `<v>`). Do not edit them by
   hand. `scripts/check-chart-version.sh` checks they agree, and the
   `chart-tests.yml` workflow runs it on every PR, so a bump that misses the
   chart fails before it merges.
2. Merge, then push the tag `v0.57.0`. `docker-publish.yml` builds both images;
   once both are on Docker Hub its `publish-chart` job calls `helm-publish.yml`,
   which checks that `Chart.yaml` is at the tag's version (and fails the release
   naming both versions if not), checks both images exist, then packages, signs
   and publishes the chart.

`helm-publish.yml` rebuilds the index under `docs/charts/` from master and
commits the tarball, its `.prov` and `index.yaml` to `master` (signed, via the
GitHub API) so GitHub Pages serves them at `https://docs.betterdb.com/charts`.
Both the `.tgz` tarballs and `index.yaml` live in the repo under
`docs/charts/`; there is no separate GitHub Release or `gh-pages` branch. A
version whose tarball is already published is skipped. To re-publish by hand
(for example after a failed run), run the "Publish Helm Chart" workflow from
the Actions tab, on `master` or with the release tag as `ref`.

Run the chart checks locally with:

```bash
scripts/check-chart-version.sh
helm lint charts/betterdb-monitor
helm plugin install https://github.com/helm-unittest/helm-unittest  # once; Helm 4 also needs --verify=false
helm unittest charts/betterdb-monitor
```

The index commit to master requires the `HELM_PUBLISH_TOKEN` repo secret: a
fine-grained PAT (contents: read/write on this repo) from a user who bypasses
the PR-review rule. The workflow commits via GraphQL `createCommitOnBranch`,
so the commit is GitHub-signed and passes the signed-commits requirement.
